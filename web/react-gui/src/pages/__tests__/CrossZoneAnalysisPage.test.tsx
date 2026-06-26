// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisCatalogEntry, AnalysisCatalogResponse } from '../../analysis/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../components/analysis/EChart', () => ({ EChart: () => <div data-testid="echart" /> }));
const exportMenuProps = vi.fn();
const saveViewMock = vi.fn();
vi.mock('../../components/analysis/AnalysisExportMenu', () => ({
  AnalysisExportMenu: (props: {
    username?: string | null;
  }) => {
    exportMenuProps(props);
    return <div data-testid="export-menu" />;
  },
}));
vi.mock('../../components/analysis/AnalysisViewsMenu', () => ({
  AnalysisViewsMenu: ({
    onLoad,
    onSave,
    views,
  }: {
    onLoad: (view: unknown) => void;
    onSave: (name: string) => void;
    views: unknown[];
  }) => (
    <div>
      <button type="button" data-testid="load-view" onClick={() => onLoad(views[0])}>load</button>
      <button type="button" data-testid="save-view" onClick={() => onSave('Broken save')}>save</button>
    </div>
  ),
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ username: 'field-admin' }),
}));

const getSeries = vi.fn();
const STORAGE_KEY = 'osi.analysis.workspace.v1';
const ambientTemperatureSeriesId = '52f63dffa76919e6';
const legacyTemperatureSeriesId = 'aa7ae37051ff2a50';
let appliedAggregation = 'hourly';
let catalogState: {
  catalog: AnalysisCatalogResponse | null;
  isLoading: boolean;
  error: undefined;
};

vi.mock('../../analysis/useAnalysisCatalog', () => ({
  useAnalysisCatalog: () => catalogState,
}));
vi.mock('../../analysis/useAnalysisSeries', () => ({
  useAnalysisSeries: (req: unknown) => {
    getSeries(req);
    return {
      data: req ? {
        generatedAt: 'now',
        range: {
          label: '7d',
          from: '2026-06-01T00:00:00Z',
          to: '2026-06-07T23:59:59Z',
          timezone: 'UTC',
        },
        aggregation: { requested: 'auto', applied: appliedAggregation, bucketSizeSeconds: 3600 },
        grid: { stepSeconds: 3600, from: '2026-06-01T00:00:00Z', to: '2026-06-07T23:59:59Z', bucketCount: 1 },
        series: [],
        dropped: [],
      } : undefined,
      isLoading: false,
      error: undefined,
    };
  },
}));

function loadedCatalogState() {
  const channels: AnalysisCatalogEntry[] = [
    { seriesId: 's1', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1', displayName: 'SWT 1', unit: 'kPa', availability: 'available', deviceName: null, depthCm: null },
    { seriesId: 's2', hubEui: 'HUB-2', zoneId: 2, zoneName: 'South', cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1', displayName: 'SWT 1 East', unit: 'kPa', availability: 'available', deviceName: null, depthCm: null },
    { seriesId: ambientTemperatureSeriesId, hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'environment', sourceKey: 'microclimate', channelKey: 'ambient_temperature', displayName: 'Air temperature', unit: 'C', availability: 'available', deviceName: null, depthCm: null },
    { seriesId: 's4', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_2', displayName: 'SWT 2', unit: 'kPa', availability: 'unsupported', deviceName: null, depthCm: null },
  ];
  return {
    catalog: { generatedAt: 'now', channels },
    isLoading: false,
    error: undefined,
  };
}
vi.mock('../../analysis/useAnalysisViews', () => ({
  useAnalysisViews: () => ({
    views: [
      {
        id: 9,
        name: 'Saved',
        schemaVersion: 1,
        isDefault: false,
        updatedAt: 't',
        viewJson: {
        schemaVersion: 1,
        selectors: [{ seriesId: 's1' }],
        range: {
          mode: 'custom',
          label: 'custom',
          from: '2026-06-01T08:30',
          to: '2026-06-02T09:45',
        },
        mode: 'timeline',
        layout: 'stacked',
        toggles: { normalize: false },
        },
      },
    ],
    isLoading: false,
    error: undefined,
    saveView: saveViewMock,
    refresh: vi.fn(),
  }),
}));

import { CrossZoneAnalysisPage } from '../CrossZoneAnalysisPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  appliedAggregation = 'hourly';
  catalogState = loadedCatalogState();
});

describe('CrossZoneAnalysisPage', () => {
  it('does not request legacy series ids before the catalog is available and migrates once it loads', () => {
    catalogState = { catalog: null, isLoading: true, error: undefined };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      selectors: [{ seriesId: legacyTemperatureSeriesId }],
      range: { mode: 'relative', label: '7d', from: null, to: null },
      mode: 'timeline',
      layout: 'stacked',
      toggles: { normalize: false },
    }));

    const view = render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });

    expect(getSeries).toHaveBeenLastCalledWith(null);
    expect(getSeries.mock.calls).not.toContainEqual([
      expect.objectContaining({ selectors: [{ seriesId: legacyTemperatureSeriesId }] }),
    ]);

    catalogState = loadedCatalogState();
    view.rerender(<CrossZoneAnalysisPage />);

    expect(getSeries).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectors: [{ seriesId: ambientTemperatureSeriesId }] }),
    );
  });

  it('lists catalog channels and requests series after one is added', () => {
    catalogState = loadedCatalogState();
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });
    expect(screen.getByTestId('export-menu')).toBeInTheDocument();
    expect(screen.getByText('SWT 1')).toBeInTheDocument();
    // initially no selectors -> series request is null
    expect(getSeries).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByText('SWT 1'));
    expect(getSeries).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectors: [{ seriesId: 's1' }] }),
    );
  });

  it('loads a saved view into the workspace and requests its series', () => {
    catalogState = loadedCatalogState();
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });
    expect(getSeries).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByTestId('load-view'));
    expect(getSeries).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectors: [{ seriesId: 's1' }] }),
    );
  });

  it('shows a visible error when saving a view fails', async () => {
    catalogState = loadedCatalogState();
    saveViewMock.mockRejectedValueOnce(new Error('save failed'));
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });

    fireEvent.click(screen.getByTestId('save-view'));

    expect(await screen.findByText('analysis.loadError')).toBeInTheDocument();
  });

  it('shows the applied aggregation level once series data is loaded', () => {
    catalogState = loadedCatalogState();
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });
    expect(screen.queryByText('analysis.aggregation.label')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('SWT 1'));
    expect(screen.getByText('analysis.aggregation.label')).toBeInTheDocument();
    expect(screen.getByText('analysis.aggregation.hourly')).toBeInTheDocument();
  });

  it('labels the backend 15m aggregation level without falling back to hourly', () => {
    catalogState = loadedCatalogState();
    appliedAggregation = '15m';
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });

    fireEvent.click(screen.getByText('SWT 1'));

    expect(screen.getByText('analysis.aggregation.fifteenMinute')).toBeInTheDocument();
    expect(screen.queryByText('analysis.aggregation.hourly')).not.toBeInTheDocument();
  });

  it('labels the backend weekly aggregation level without falling back to hourly', () => {
    catalogState = loadedCatalogState();
    appliedAggregation = 'weekly';
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });

    fireEvent.click(screen.getByText('SWT 1'));

    expect(screen.getByText('analysis.aggregation.weekly')).toBeInTheDocument();
    expect(screen.queryByText('analysis.aggregation.hourly')).not.toBeInTheDocument();
  });

  it('renders unknown backend aggregation values as their raw label', () => {
    catalogState = loadedCatalogState();
    appliedAggregation = '10m';
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });

    fireEvent.click(screen.getByText('SWT 1'));

    expect(screen.getByText('10m')).toBeInTheDocument();
    expect(screen.queryByText('analysis.aggregation.hourly')).not.toBeInTheDocument();
  });

  it('passes the current username to the export menu', () => {
    catalogState = loadedCatalogState();
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });
    expect(exportMenuProps).toHaveBeenCalledWith(expect.objectContaining({ username: 'field-admin' }));
  });

  it('does not pass server-only history export props to the edge export menu', () => {
    catalogState = loadedCatalogState();
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });

    fireEvent.click(screen.getByText('SWT 1'));

    expect(exportMenuProps.mock.lastCall?.[0]).not.toHaveProperty('exportRange');
    expect(exportMenuProps.mock.lastCall?.[0]).not.toHaveProperty('exportGranularity');
  });

  it('hydrates saved custom range values into the page controls', () => {
    catalogState = loadedCatalogState();
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });

    fireEvent.click(screen.getByTestId('load-view'));

    expect(screen.getByLabelText('analysis.range.from')).toHaveValue('2026-06-01T08:30');
    expect(screen.getByLabelText('analysis.range.to')).toHaveValue('2026-06-02T09:45');
  });

  it('persists layout changes from the page controls', () => {
    catalogState = loadedCatalogState();
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });
    fireEvent.click(screen.getByRole('button', { name: 'analysis.layout.overlaid' }));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(
      expect.objectContaining({ layout: 'overlaid' }),
    );
  });

  it('applies a metric-across-zones preset from the overlaid timeline layout', () => {
    catalogState = loadedCatalogState();
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });

    fireEvent.click(screen.getByRole('button', { name: 'analysis.layout.overlaid' }));
    const preset = screen.getByRole('region', { name: 'analysis.preset.metricLabel' });
    fireEvent.click(within(preset).getByRole('button', { name: /^SWT 1/ }));

    expect(screen.getByText('analysis.preset.metricLabel')).toBeInTheDocument();
    expect(getSeries).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectors: [{ seriesId: 's1' }, { seriesId: 's2' }],
      }),
    );
    expect(getSeries).not.toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectors: expect.arrayContaining([{ seriesId: 's4' }]),
      }),
    );
  });

  it('migrates legacy localStorage selectors to canonical series ids before requesting data', () => {
    catalogState = loadedCatalogState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      selectors: [{ seriesId: legacyTemperatureSeriesId }],
      range: { mode: 'relative', label: '7d', from: null, to: null },
      mode: 'timeline',
      layout: 'stacked',
      toggles: { normalize: false },
      labelOverrides: { [legacyTemperatureSeriesId]: 'Greenhouse air' },
    }));

    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });

    const nonNullRequests = getSeries.mock.calls
      .map(([request]) => request)
      .filter((request): request is { selectors: { seriesId: string }[] } => request !== null);

    expect(nonNullRequests).toContainEqual(
      expect.objectContaining({ selectors: [{ seriesId: ambientTemperatureSeriesId }] }),
    );
    expect(nonNullRequests).not.toContainEqual(
      expect.objectContaining({ selectors: [{ seriesId: legacyTemperatureSeriesId }] }),
    );
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(
      expect.objectContaining({
        selectors: [{ seriesId: ambientTemperatureSeriesId }],
        labelOverrides: { [ambientTemperatureSeriesId]: 'Greenhouse air' },
      }),
    );
  });
});
