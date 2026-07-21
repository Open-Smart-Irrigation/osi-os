import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import i18next from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../../public/locales/en/journal.json';
import type { StationPlotPosition } from '../../../../journal/stationModel';
import type { JournalPlot } from '../../../../types/journal';
import type { StationGridProps } from '../../where/StationGrid';

const translate = vi.hoisted(() => vi.fn((key: string, options?: Record<string, unknown>) => {
  const interpolationOptions = options ?? {};
  const fallback = interpolationOptions.defaultValue;
  if (typeof fallback !== 'string') return key;
  return fallback.replace(/\{\{(\w+)\}\}/g, (_, token: string) => {
    const value = interpolationOptions[token];
    return value == null ? `{{${token}}}` : String(value);
  });
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

import { StationGrid } from '../../where/StationGrid';

function plot(plotUuid: string, plotCode: string, name: string, stationCode = 'A'): JournalPlot {
  return {
    contract_version: 1,
    plot_uuid: plotUuid,
    plot_code: plotCode,
    name,
    zone_uuid: 'zone-1',
    station_code: stationCode,
    crop_hint: null,
    area_m2: 100,
    active: 1,
    sync_version: 1,
    owner_user_uuid: 'user-1',
    gateway_device_eui: 'ABCDEF0123456789',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    deleted_at: null,
    settings: {
      layout_code: 'open_field',
      updated_at: '2026-07-15T00:00:00.000Z',
      updated_by_principal_uuid: 'user-1',
      sync_version: 1,
    },
  };
}

const gridPlots: StationPlotPosition[] = [
  { plot: plot('plot-1', 'A-1', 'North field'), gridNumber: 1, sourceNumber: 1 },
  { plot: plot('plot-2', 'A-2', 'Middle field'), gridNumber: 2, sourceNumber: 2 },
  { plot: plot('plot-3', 'A-3', 'South field'), gridNumber: 3, sourceNumber: 3 },
];
const namedFallbackPlot = plot('plot-named', 'A-west', 'North-west');

function props(overrides: Partial<StationGridProps> = {}): StationGridProps {
  return {
    stationCode: 'A',
    stationLabel: 'Station Alpha',
    plots: gridPlots,
    namedFallbackPlots: [namedFallbackPlot],
    selectedPlotUuids: new Set(['plot-1']),
    rangeText: '1-2',
    rangeError: null,
    onTogglePlot: vi.fn(),
    onSelectAll: vi.fn(),
    onInvert: vi.fn(),
    onRangeTextChange: vi.fn(),
    onApplyRange: vi.fn(),
    ...overrides,
  };
}

function expandStation(): void {
  const summary = screen.getByText('Station Alpha').closest('summary');
  expect(summary).not.toBeNull();
  fireEvent.click(summary as HTMLElement);
}

describe('StationGrid', () => {
  beforeEach(() => {
    translate.mockClear();
  });

  it('renders one collapsed station row instead of a long plot list', () => {
    const { container } = render(<StationGrid {...props()} />);

    expect(container.querySelectorAll('details')).toHaveLength(1);
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    expect(screen.getByText(/4 plots/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /1.*North field/ })).not.toBeInTheDocument();
  });

  it.each([
    {
      plots: gridPlots.slice(0, 1),
      selectedPlotUuids: new Set(['plot-1']),
      plotCountDefault: '{{count}} plot',
      plotCountLabel: '1 plot',
      selectedCountLabel: '1 selected',
      summary: 'Station Alpha · 1 plot · 1 selected',
    },
    {
      plots: gridPlots.slice(0, 2),
      selectedPlotUuids: new Set(['plot-1']),
      plotCountDefault: '{{count}} plots',
      plotCountLabel: '2 plots',
      selectedCountLabel: '1 selected',
      summary: 'Station Alpha · 2 plots · 1 selected',
    },
    {
      plots: gridPlots.slice(0, 2),
      selectedPlotUuids: new Set(['plot-1', 'plot-2']),
      plotCountDefault: '{{count}} plots',
      plotCountLabel: '2 plots',
      selectedCountLabel: '2 selected',
      summary: 'Station Alpha · 2 plots · 2 selected',
    },
  ])('localizes $plotCountLabel and $selectedCountLabel before composing the summary', ({
    plots,
    selectedPlotUuids,
    plotCountDefault,
    plotCountLabel,
    selectedCountLabel,
    summary,
  }) => {
    render(<StationGrid {...props({
      plots,
      namedFallbackPlots: [],
      selectedPlotUuids,
    })} />);

    expect(translate).toHaveBeenCalledWith('where.rangePlotCount', {
      count: plots.length,
      defaultValue: plotCountDefault,
    });
    expect(translate).toHaveBeenCalledWith('where.rangeSelectedCount', {
      count: selectedPlotUuids.size,
      defaultValue: '{{count}} selected',
    });
    expect(translate).toHaveBeenCalledWith('where.rangeSummary', {
      defaultValue: '{{label}} · {{plotCount}} · {{selectedCount}}',
      label: 'Station Alpha',
      count: plots.length,
      selected: selectedPlotUuids.size,
      plotCount: plotCountLabel,
      selectedCount: selectedCountLabel,
    });
    expect(screen.getByText(summary)).toBeInTheDocument();
  });

  it('bridges StationGrid range summary options to the current English resource', async () => {
    render(<StationGrid {...props({
      plots: gridPlots.slice(0, 2),
      namedFallbackPlots: [],
      selectedPlotUuids: new Set(['plot-1']),
    })} />);

    const rangeSummaryCall = translate.mock.calls.find(([key]) => key === 'where.rangeSummary');
    expect(rangeSummaryCall).toBeDefined();
    const rangeSummaryOptions = rangeSummaryCall?.[1];
    expect(rangeSummaryOptions).toBeDefined();

    const i18n = i18next.createInstance();
    try {
      await i18n.init({
        lng: 'en',
        ns: ['journal'],
        defaultNS: 'journal',
        resources: { en: { journal: en } },
      });

      const summary = i18n.t('journal:where.rangeSummary', rangeSummaryOptions);

      expect(summary).toBe('Station Alpha · 2 plots · 1 selected');
      expect(summary).not.toMatch(/\{\{[^}]+\}\}/);
    } finally {
      i18n.removeResourceBundle('en', 'journal');
    }
  });

  it('expands a numbered grid with toggle buttons', () => {
    render(<StationGrid {...props()} />);

    expandStation();

    const grid = screen.getByRole('group', { name: 'Station Alpha' });
    const northField = within(grid).getByRole('button', { name: '1 North field' });
    expect(northField).toHaveAttribute('aria-pressed', 'true');
    expect(northField).not.toHaveAttribute('aria-label');
    expect(within(grid).getByRole('button', { name: '2 Middle field' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(grid).getByRole('button', { name: '3 South field' })).toBeInTheDocument();
    expect(translate.mock.calls.map(([key]) => key)).not.toContain('where.gridPlot');
    expect(translate.mock.calls.map(([key]) => key)).not.toContain('where.numericGrid');
  });

  it('keeps select all and invert scoped to the station', () => {
    const onSelectAll = vi.fn();
    const onInvert = vi.fn();
    const onTogglePlot = vi.fn();
    render(<StationGrid {...props({ onSelectAll, onInvert, onTogglePlot })} />);

    expandStation();
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Invert selection' }));

    expect(onSelectAll).toHaveBeenCalledTimes(1);
    expect(onInvert).toHaveBeenCalledTimes(1);
    expect(onTogglePlot).not.toHaveBeenCalled();
  });

  it('shows the range input and the translated parse error, without a raw code:token debug suffix', () => {
    render(<StationGrid {...props({
      rangeError: { ok: false, code: 'out_of_station', token: '2-4' },
    })} />);

    expandStation();

    expect(screen.getByRole('textbox', { name: 'Station range' })).toHaveValue('1-2');
    expect(screen.getByRole('alert')).toHaveTextContent('The station range is invalid.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('out_of_station');
    expect(screen.getByRole('alert')).not.toHaveTextContent('2-4');
  });

  it.each([
    ['empty', 'where.rangeEmpty', ''],
    ['malformed', 'where.rangeMalformed', '2--4'],
    ['duplicate', 'where.rangeDuplicate', '5'],
    ['out_of_station', 'where.rangeOutOfStation', '9'],
    ['reversed', 'where.rangeReversed', '12-10'],
    ['non_integer', 'where.rangeNonInteger', '2.5'],
    ['non_positive', 'where.rangeNonPositive', '0'],
  ] as const)('maps the %s parser error to its dedicated translation key', (
    code,
    translationKey,
    token,
  ) => {
    render(<StationGrid {...props({
      rangeError: { ok: false, code, token },
    })} />);

    expandStation();

    expect(translate).toHaveBeenCalledWith(translationKey, {
      defaultValue: 'The station range is invalid.',
    });
  });

  // A very long/hostile token must never reach the DOM at all (not just be
  // wrapped nicely) — the error surface only ever shows the translated
  // message, never the raw parser code/token debug pair.
  it('never leaks a long or hostile range-error token into the alert', () => {
    const token = 'hostile-range-token-'.repeat(24);
    render(<StationGrid {...props({
      rangeError: { ok: false, code: 'malformed', token },
    })} />);

    expandStation();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The station range is invalid.');
    expect(alert.textContent).not.toContain(token);
    expect(alert.textContent).not.toContain('malformed');
    expect(alert).toHaveClass('min-w-0', 'whitespace-pre-wrap', 'break-words');
  });

  it('uses a text-capable input mode for comma and hyphen range syntax', () => {
    render(<StationGrid {...props()} />);

    expandStation();

    const input = screen.getByRole('textbox', { name: 'Station range' });
    expect(input).toHaveAttribute('inputmode', 'text');
    expect(input).not.toHaveAttribute('inputmode', 'numeric');
  });

  it('calls the accessible apply callback from the button and Enter', () => {
    const onApplyRange = vi.fn();
    const onRangeTextChange = vi.fn();
    render(<StationGrid {...props({ onApplyRange, onRangeTextChange })} />);

    expandStation();
    const input = screen.getByRole('textbox', { name: 'Station range' });
    fireEvent.change(input, { target: { value: '2-3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply range' }));
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onRangeTextChange).toHaveBeenCalledWith('2-3');
    expect(onApplyRange).toHaveBeenCalledTimes(2);
  });

  it('renders named nonnumeric fallback plots outside the numeric grid', () => {
    render(<StationGrid {...props()} />);

    expandStation();

    const namedPlots = screen.getByRole('group', { name: 'Named plots' });
    const numericGrid = screen.getByRole('group', { name: 'Station Alpha' });
    expect(within(namedPlots).getByRole('button', { name: /North-west/ })).toBeInTheDocument();
    expect(within(numericGrid).queryByRole('button', { name: /North-west/ })).not.toBeInTheDocument();
  });

  it('renders a selection count and human labels', () => {
    render(<StationGrid {...props({ selectedPlotUuids: new Set(['plot-1', 'plot-named']) })} />);

    expect(screen.getByText(/2 selected/)).toBeInTheDocument();
    expandStation();

    expect(screen.getByRole('button', { name: /1.*North field/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /North-west/ })).toBeInTheDocument();
    expect(screen.queryByText('plot-1')).not.toBeInTheDocument();
  });

  it('keeps primary controls at least 56px', () => {
    const { container } = render(<StationGrid {...props()} />);

    expandStation();

    expect(container.querySelector('summary')).toHaveClass('min-h-[56px]');
    expect(screen.getByRole('textbox', { name: 'Station range' })).toHaveClass('min-h-[56px]');
    expect(screen.getAllByRole('button')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ className: expect.stringContaining('min-h-[56px]') }),
      ]),
    );
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveClass('min-h-[56px]');
    }
  });

  it('renders focusable grid controls with visible focus classes', () => {
    const { container } = render(<StationGrid {...props()} />);

    expandStation();

    expect(container.querySelector('summary')).toHaveClass('focus-visible:ring-2');
    expect(screen.getByRole('textbox', { name: 'Station range' })).toHaveClass('focus-visible:ring-2');
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveClass('focus-visible:ring-2');
    }
  });
});
