// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  JournalPlot,
  JournalPlotGroupWritePayload,
  PlotGroup,
} from '../../../../types/journal';
import { PlotPicker, type PlotSelection } from '../../where/PlotPicker';

const translationMocks = vi.hoisted(() => ({ t: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      translationMocks.t(key, options);
      const defaults: Record<string, string> = {
        'where.station': 'Station',
        'where.unstationed': 'Unstationed plots',
        'where.namedPlots': 'Named plots',
        'where.noStation': 'No station',
        'where.selectAll': 'Select all',
        'where.invert': 'Invert selection',
        'where.range': 'Station range',
        'where.applyRange': 'Apply range',
        'where.rangeSummary': '{{label}} · {{count}} · {{selected}}',
        'where.rangeOutOfStation': 'The range contains a plot outside this station.',
        'where.rangeMalformed': 'The station range is invalid.',
        'where.rangeEmpty': 'The station range is empty.',
        'where.rangeDuplicate': 'The station range repeats a value.',
        'where.rangeReversed': 'The station range is reversed.',
        'where.rangeNonInteger': 'The station range must use whole numbers.',
        'where.rangeNonPositive': 'The station range must use positive numbers.',
        'where.mixedLayout': 'Selected plots use different layouts.',
        'where.maxPlots': 'Selected plots',
        'where.maxPlotsError': 'Select no more than {{count}} plots.',
        'where.noPlot': 'No plot',
        'where.selectionCount': '{{count}} plots selected',
        'where.createGroup': 'Create group',
        'where.editGroup': 'Edit group',
        'where.groupLabel': 'Group label',
        'where.saveGroup': 'Save group',
        'where.cancel': 'Cancel',
        'group.heterogeneous': 'The group contains incompatible layouts.',
        'group.error': 'Could not save the plot group.',
      };
      const value = String(options?.defaultValue ?? defaults[key] ?? key);
      return Object.entries(options ?? {}).reduce(
        (result, [name, replacement]) => result.replace(`{{${name}}}`, String(replacement)),
        value,
      );
    },
  }),
}));

const timestamp = '2026-07-18T00:00:00.000Z';

function plot(
  plotUuid: string,
  plotCode: string,
  stationCode: string | null,
  layoutCode = 'open_field',
  overrides: Partial<JournalPlot> = {},
): JournalPlot {
  return {
    contract_version: 1,
    plot_uuid: plotUuid,
    plot_code: plotCode,
    name: null,
    zone_uuid: null,
    station_code: stationCode,
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
      layout_code: layoutCode,
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
    members: ['plot-2', 'plot-1'],
    ...overrides,
  };
}

const stationPlots = [
  plot('plot-1', 'P-1', 'ST-1'),
  plot('plot-2', 'P-2', 'ST-1'),
  plot('plot-named', 'named', 'ST-1', 'open_field', { name: 'Named bed' }),
];
const basePlots = [...stationPlots, plot('plot-unstationed', 'loose', null)];
const emptySelection: PlotSelection = { plotUuids: [], layoutCode: null, isMultiPlot: false };

function renderPicker(overrides: Partial<React.ComponentProps<typeof PlotPicker>> = {}) {
  const props: React.ComponentProps<typeof PlotPicker> = {
    plots: basePlots,
    activeGroups: [],
    resolvedGroups: [],
    allowNoPlot: false,
    value: emptySelection,
    onChange: vi.fn(),
    onCreateGroup: vi.fn().mockResolvedValue(group()),
    onUpdateGroup: vi.fn().mockResolvedValue(group()),
    ...overrides,
  };
  return { ...render(<ControlledPlotPicker {...props} />), props };
}

function ControlledPlotPicker(props: React.ComponentProps<typeof PlotPicker>) {
  const [selection, setSelection] = useState(props.value);
  return (
    <PlotPicker
      {...props}
      value={selection}
      onChange={(nextSelection) => {
        props.onChange(nextSelection);
        setSelection(nextSelection);
      }}
    />
  );
}

function expandStation(label = 'ST-1') {
  fireEvent.click(screen.getByText(label, { exact: true }));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('PlotPicker', () => {
  beforeEach(() => {
    translationMocks.t.mockClear();
  });

  it('toggles all valid group members while preserving selections outside the group', () => {
    const onChange = vi.fn();
    renderPicker({
      activeGroups: [group()],
      value: { plotUuids: ['plot-unstationed'], layoutCode: 'open_field', isMultiPlot: false },
      onChange,
    });

    const groupButton = screen.getByRole('button', { name: 'North block' });
    expect(groupButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(groupButton);
    expect(onChange).toHaveBeenLastCalledWith({
      plotUuids: ['plot-1', 'plot-2', 'plot-unstationed'],
      layoutCode: 'open_field',
      isMultiPlot: true,
    });
    expect(groupButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(groupButton);
    expect(onChange).toHaveBeenLastCalledWith({
      plotUuids: ['plot-unstationed'],
      layoutCode: 'open_field',
      isMultiPlot: false,
    });
    expect(groupButton).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders active group chips before station rows and omits resolved groups', () => {
    renderPicker({
      activeGroups: [group()],
      resolvedGroups: [group({ group_uuid: 'resolved-1', label: 'Resolved old group', resolved_at: timestamp })],
    });

    expect(screen.queryByText('Resolved old group')).not.toBeInTheDocument();
    const groupHeading = screen.getByRole('button', { name: 'North block' });
    const stationHeading = screen.getByText('ST-1');
    expect(groupHeading.compareDocumentPosition(stationHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders station, named fallback, and unstationed sections from active nondeleted plots', () => {
    renderPicker({
      plots: [
        ...basePlots,
        plot('deleted', 'deleted', 'ST-1', 'open_field', { deleted_at: timestamp }),
        plot('inactive', 'inactive', 'ST-1', 'open_field', { active: 0 }),
      ],
    });

    expect(screen.getByText('ST-1')).toBeVisible();
    expect(screen.getByText('Unstationed plots')).toBeVisible();
    expect(screen.queryByText('deleted')).not.toBeInTheDocument();
    expect(screen.queryByText('inactive')).not.toBeInTheDocument();

    expandStation();
    expect(screen.getByText('Named plots')).toBeVisible();
    expect(screen.getByText('Named bed')).toBeVisible();
  });

  it('renders No plot only when allowed and selects the explicit empty scope', () => {
    const onChange = vi.fn();
    const { rerender } = renderPicker({ onChange, allowNoPlot: false });
    expect(screen.queryByRole('button', { name: 'No plot' })).not.toBeInTheDocument();

    rerender(<ControlledPlotPicker
      plots={basePlots}
      activeGroups={[]}
      resolvedGroups={[]}
      allowNoPlot
      value={emptySelection}
      onChange={onChange}
      onCreateGroup={vi.fn().mockResolvedValue(group())}
      onUpdateGroup={vi.fn().mockResolvedValue(group())}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'No plot' }));
    expect(onChange).toHaveBeenCalledWith(emptySelection);
  });

  it('emits sorted homogeneous selection layout and multi-plot state', () => {
    const onChange = vi.fn();
    renderPicker({ plots: [plot('z', 'P-2', 'ST-1'), plot('a', 'P-1', 'ST-1')], onChange });
    expandStation();

    fireEvent.click(screen.getByRole('button', { name: /P-2/ }));
    fireEvent.click(screen.getByRole('button', { name: /P-1/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      plotUuids: ['a', 'z'],
      layoutCode: 'open_field',
      isMultiPlot: true,
    });
  });

  it('reflects a new parent value on rerender without internal canonical selection', () => {
    const onChange = vi.fn();
    const onCreateGroup = vi.fn().mockResolvedValue(group());
    const onUpdateGroup = vi.fn().mockResolvedValue(group());
    const { rerender } = render(<PlotPicker
      plots={basePlots}
      activeGroups={[group()]}
      resolvedGroups={[]}
      allowNoPlot={false}
      value={{ plotUuids: ['plot-1'], layoutCode: 'open_field', isMultiPlot: false }}
      onChange={onChange}
      onCreateGroup={onCreateGroup}
      onUpdateGroup={onUpdateGroup}
    />);

    expect(screen.getByRole('button', { name: 'P-1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'P-2' })).toHaveAttribute('aria-pressed', 'false');

    rerender(<PlotPicker
      plots={basePlots}
      activeGroups={[group()]}
      resolvedGroups={[]}
      allowNoPlot={false}
      value={{ plotUuids: ['plot-2'], layoutCode: 'open_field', isMultiPlot: false }}
      onChange={onChange}
      onCreateGroup={onCreateGroup}
      onUpdateGroup={onUpdateGroup}
    />);

    expect(screen.getByRole('button', { name: 'P-1' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'P-2' })).toHaveAttribute('aria-pressed', 'true');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('excludes stale controlled IDs from counts and create members, then reconciles them on a valid action', async () => {
    const inactive = plot('inactive-id', 'inactive', 'ST-1', 'open_field', { active: 0 });
    const deleted = plot('deleted-id', 'deleted', 'ST-1', 'open_field', { deleted_at: timestamp });
    const onChange = vi.fn();
    const onCreateGroup = vi.fn().mockResolvedValue(group());
    renderPicker({
      plots: [...basePlots, inactive, deleted],
      activeGroups: [group()],
      value: {
        plotUuids: ['plot-1', 'plot-2', 'inactive-id', 'deleted-id', 'unknown-id'],
        layoutCode: 'open_field',
        isMultiPlot: true,
      },
      onChange,
      onCreateGroup,
    });

    expect(screen.getByText('2 plots selected')).toBeVisible();
    expect(screen.getByText('Some selected plots are no longer available. Choose an active plot to update the selection.')).toBeVisible();
    expect(translationMocks.t).toHaveBeenCalledWith('where.staleSelection', {
      defaultValue: 'Some selected plots are no longer available. Choose an active plot to update the selection.',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Group label' }), { target: { value: 'Active pair' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save group' }));

    await vi.waitFor(() => expect(onCreateGroup).toHaveBeenCalledTimes(1));
    expect(onCreateGroup).toHaveBeenCalledWith(expect.objectContaining({
      label: 'Active pair',
      members: ['plot-1', 'plot-2'],
    }));

    fireEvent.click(screen.getByRole('button', { name: 'loose' }));
    expect(onChange).toHaveBeenLastCalledWith({
      plotUuids: ['plot-1', 'plot-2', 'plot-unstationed'],
      layoutCode: 'open_field',
      isMultiPlot: true,
    });
    expect(screen.queryByText('Some selected plots are no longer available. Choose an active plot to update the selection.')).not.toBeInTheDocument();
  });

  it('rejects inactive, deleted, and unknown group candidate IDs before onChange', () => {
    const onChange = vi.fn();
    renderPicker({
      plots: [
        ...basePlots,
        plot('inactive-id', 'inactive', 'ST-1', 'open_field', { active: 0 }),
        plot('deleted-id', 'deleted', 'ST-1', 'open_field', { deleted_at: timestamp }),
      ],
      activeGroups: [group({ members: ['plot-1', 'inactive-id', 'deleted-id', 'unknown-id'] })],
      onChange,
    });

    expect(screen.queryByRole('button', { name: 'inactive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'deleted' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'unknown-id' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'North block' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('stale_plot_membership')).toBeVisible();
  });

  it('blocks a rejected controlled candidate and leaves the supplied value unchanged', () => {
    const onChange = vi.fn();
    const mixedPlots = [
      plot('plot-a', 'P-1', 'ST-1', 'open_field'),
      plot('plot-b', 'P-2', 'ST-1', 'greenhouse'),
    ];
    render(<PlotPicker
      plots={mixedPlots}
      activeGroups={[group({ members: ['plot-a', 'plot-b'] })]}
      resolvedGroups={[]}
      allowNoPlot={false}
      value={{ plotUuids: ['plot-a'], layoutCode: 'open_field', isMultiPlot: false }}
      onChange={onChange}
      onCreateGroup={vi.fn().mockResolvedValue(group())}
      onUpdateGroup={vi.fn().mockResolvedValue(group())}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'North block' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('heterogeneous_group');
    expect(screen.getByRole('button', { name: 'P-1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'P-2' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('rejects a 101st selection visibly without truncating or notifying the parent', () => {
    const plots = Array.from({ length: 101 }, (_, index) => plot(`plot-${String(index).padStart(3, '0')}`, `P-${index + 1}`, 'ST-1'));
    const value = {
      plotUuids: plots.slice(0, 100).map(({ plot_uuid }) => plot_uuid),
      layoutCode: 'open_field',
      isMultiPlot: true,
    } satisfies PlotSelection;
    const onChange = vi.fn();
    renderPicker({ plots, value, onChange });
    expandStation();

    fireEvent.click(screen.getByRole('button', { name: /P-101/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(translationMocks.t).toHaveBeenCalledWith('where.maxPlotsError', {
      count: 100,
      defaultValue: 'Select no more than {{count}} plots.',
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Select no more than 100 plots.');
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(100);
  });

  it('keeps range text and errors scoped per station while preserving other selections', () => {
    const onChange = vi.fn();
    renderPicker({
      plots: [
        plot('one', 'P-1', 'ST-1'),
        plot('two', 'P-2', 'ST-1'),
        plot('other', 'P-1', 'ST-2'),
        plot('other-2', 'P-2', 'ST-2'),
        plot('named', 'named', 'ST-1', 'open_field', { name: 'Named bed' }),
        plot('loose', 'loose', null),
      ],
      value: { plotUuids: ['one', 'other', 'named', 'loose'], layoutCode: 'open_field', isMultiPlot: true },
      onChange,
    });
    expandStation('ST-1');
    expandStation('ST-2');
    const stationOne = screen.getByRole('group', { name: 'ST-1' }).closest('details');
    const stationTwo = screen.getByRole('group', { name: 'ST-2' }).closest('details');
    expect(stationOne).toBeTruthy();
    expect(stationTwo).toBeTruthy();
    const stationOneScope = within(stationOne as HTMLElement);
    const stationTwoScope = within(stationTwo as HTMLElement);

    fireEvent.change(stationOneScope.getByRole('textbox'), { target: { value: '1, 9' } });
    fireEvent.change(stationTwoScope.getByRole('textbox'), { target: { value: '2' } });
    expect(stationOneScope.getByRole('textbox')).toHaveValue('1, 9');
    expect(stationTwoScope.getByRole('textbox')).toHaveValue('2');

    fireEvent.click(stationOneScope.getByRole('button', { name: 'Apply range' }));
    // P2-c: the alert shows only the translated message now — the raw
    // `code: token` debug suffix (e.g. "out_of_station: 9") was dropped. This
    // mock's `t` always resolves the component's own hardcoded defaultValue
    // (see its `options?.defaultValue ?? defaults[key]` precedence above),
    // so the visible text is that generic message, not a per-code one.
    expect(stationOneScope.getByRole('alert')).toHaveTextContent('The station range is invalid.');
    expect(stationOneScope.getByRole('alert')).not.toHaveTextContent('out_of_station');
    expect(stationTwoScope.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(stationTwoScope.getByRole('button', { name: 'Apply range' }));
    expect(onChange).toHaveBeenLastCalledWith({
      plotUuids: ['loose', 'named', 'one', 'other-2'],
      layoutCode: 'open_field',
      isMultiPlot: true,
    });
    expect(stationOneScope.getByRole('alert')).toHaveTextContent('The station range is invalid.');
    expect(stationTwoScope.queryByRole('alert')).not.toBeInTheDocument();
    expect(stationOneScope.getByRole('textbox')).toHaveValue('1, 9');
    expect(stationTwoScope.getByRole('textbox')).toHaveValue('2');

    fireEvent.change(stationOneScope.getByRole('textbox'), { target: { value: '2' } });
    fireEvent.click(stationOneScope.getByRole('button', { name: 'Apply range' }));
    expect(onChange).toHaveBeenLastCalledWith({
      plotUuids: ['loose', 'named', 'other-2', 'two'],
      layoutCode: 'open_field',
      isMultiPlot: true,
    });
  });

  it('offers manual Create group and sends the exact sorted create payload', async () => {
    const generatedUuid = '11111111-1111-4111-8111-111111111111';
    const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(generatedUuid);
    const onCreateGroup = vi.fn().mockResolvedValue(group());
    try {
      renderPicker({
        plots: [plot('z', 'P-2', 'ST-1'), plot('a', 'P-1', 'ST-1')],
        onCreateGroup,
      });
      expandStation();
      fireEvent.click(screen.getByRole('button', { name: /P-2/ }));
      fireEvent.click(screen.getByRole('button', { name: /P-1/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Group label' }), {
        target: { value: '  North pair  ' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save group' }));

      await vi.waitFor(() => expect(onCreateGroup).toHaveBeenCalledTimes(1));
      expect(onCreateGroup).toHaveBeenCalledWith({
        group_uuid: generatedUuid,
        base_sync_version: 0,
        label: 'North pair',
        members: ['a', 'z'],
        resolved: false,
      } satisfies JournalPlotGroupWritePayload);
    } finally {
      randomUuid.mockRestore();
    }
  });

  it('keeps one create UUID across a pending double-submit and retry while disabling competing actions', async () => {
    const generatedUuid = '11111111-1111-4111-8111-111111111111';
    const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(generatedUuid);
    const firstSave = deferred<PlotGroup>();
    const onCreateGroup = vi.fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(group());
    try {
      renderPicker({
        activeGroups: [group()],
        value: { plotUuids: ['plot-1', 'plot-2'], layoutCode: 'open_field', isMultiPlot: true },
        onCreateGroup,
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
      expect(randomUuid).toHaveBeenCalledTimes(1);

      const input = screen.getByRole('textbox', { name: 'Group label' });
      const form = input.closest('form');
      expect(form).not.toBeNull();
      fireEvent.change(input, { target: { value: 'Retry group' } });
      fireEvent.submit(form as HTMLFormElement);
      fireEvent.submit(form as HTMLFormElement);

      expect(onCreateGroup).toHaveBeenCalledTimes(1);
      expect(onCreateGroup).toHaveBeenCalledWith(expect.objectContaining({ group_uuid: generatedUuid }));
      expect(input).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Save group' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'North block' })).toBeDisabled();
      expect(screen.getByRole('button', { name: /edit group north block/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'P-1' })).toBeDisabled();

      await act(async () => {
        firstSave.reject(new Error('temporary failure'));
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Save group' })).toBeEnabled());

      fireEvent.submit(form as HTMLFormElement);
      await vi.waitFor(() => expect(onCreateGroup).toHaveBeenCalledTimes(2));
      expect(onCreateGroup.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ group_uuid: generatedUuid }));
      expect(randomUuid).toHaveBeenCalledTimes(1);
    } finally {
      randomUuid.mockRestore();
    }
  });

  it('uses form submission for Enter and disables Save for a blank trimmed label', async () => {
    const onCreateGroup = vi.fn().mockResolvedValue(group());
    renderPicker({
      value: { plotUuids: ['plot-1', 'plot-2'], layoutCode: 'open_field', isMultiPlot: true },
      onCreateGroup,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    const input = screen.getByRole('textbox', { name: 'Group label' });
    const save = screen.getByRole('button', { name: 'Save group' });
    expect(input.closest('form')).not.toBeNull();
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(save).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(onCreateGroup).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'Keyboard group' } });
    expect(save).toBeEnabled();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await vi.waitFor(() => expect(onCreateGroup).toHaveBeenCalledTimes(1));
    expect(onCreateGroup).toHaveBeenCalledWith(expect.objectContaining({ label: 'Keyboard group' }));
    expect(save).toHaveClass('min-h-[56px]');
    expect(save).toHaveClass('focus-visible:ring-2');
  });

  it('edits an active group with its current version, label, members, and unresolved state', async () => {
    const onUpdateGroup = vi.fn().mockResolvedValue(group());
    renderPicker({ activeGroups: [group()], onUpdateGroup });
    fireEvent.click(screen.getByRole('button', { name: /edit group north block/i }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Group label' }), { target: { value: 'Renamed block' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save group' }));

    await vi.waitFor(() => expect(onUpdateGroup).toHaveBeenCalledTimes(1));
    expect(onUpdateGroup).toHaveBeenCalledWith('group-1', {
      group_uuid: 'group-1',
      base_sync_version: 7,
      label: 'Renamed block',
      members: ['plot-1', 'plot-2'],
      resolved: false,
    });
  });

  it('renders the exact Axios response.data for a heterogeneous group failure', async () => {
    const failure = {
      response: {
        data: {
          error: 'heterogeneous_group',
          message: 'Group members use different layouts',
          details: null,
        },
      },
    };
    const onUpdateGroup = vi.fn().mockRejectedValue(failure);
    renderPicker({ activeGroups: [group()], onUpdateGroup });
    fireEvent.click(screen.getByRole('button', { name: /edit group north block/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save group' }));

    const serializedResponseData = JSON.stringify(failure.response.data);
    await vi.waitFor(() => expect(screen.getByText(serializedResponseData, { exact: true })).toBeVisible());
    expect(translationMocks.t).toHaveBeenCalledWith('group.error', {
      defaultValue: 'Could not save the plot group.',
    });
  });
});
