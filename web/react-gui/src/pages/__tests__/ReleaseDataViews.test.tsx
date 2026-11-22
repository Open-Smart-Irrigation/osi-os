// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisCatalogEntry, AnalysisSeriesRequest } from '../../analysis/types';
import { AnalysisRoute } from '../AnalysisRoute';

const api = vi.hoisted(() => ({
  catalog: vi.fn(),
  series: vi.fn(),
  listViews: vi.fn(),
  settings: vi.fn(),
  download: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../components/AppHeader', () => ({ AppHeader: () => null }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ username: 'operator' }) }));
vi.mock('../../contexts/ScopeContext', () => ({ useScope: () => ({ isAdmin: false, loading: false }) }));
vi.mock('../../services/api', () => ({
  analysisAPI: { getChannels: api.catalog, getSeries: api.series, listViews: api.listViews },
  systemSettingsAPI: { get: api.settings },
}));
vi.mock('../../components/analysis/EChart', () => ({
  EChart: () => <div data-testid="timeline-plot" />,
}));
vi.mock('../../analysis/download', () => ({ downloadBlob: api.download }));

const assigned = uc512Channel('pressure-assigned', 'Assigned UC512', 1, 'pipe_pressure_kpa', 'kPa');
const pulse = uc512Channel('pulse-assigned', 'Assigned UC512', 1, 'valve_1_pulse', 'count');
const unassigned = uc512Channel('pressure-unassigned', 'Unassigned UC512', null, 'pipe_pressure_kpa', 'kPa');
const channels = [assigned, pulse, unassigned];

function uc512Channel(id: string, deviceName: string, zoneId: number | null, channelKey: string, unit: string): AnalysisCatalogEntry {
  return {
    seriesId: id, deviceName, zoneId, channelKey, unit, hubEui: null,
    zoneName: zoneId ? 'North' : null, cardType: 'irrigation',
    sourceKind: 'device', sourceKey: deviceName, deviceSourceId: deviceName,
    displayName: id, availability: 'available', depthCm: null,
  };
}

function arrangeBrowser(width: number, mobile: boolean) {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('matchMedia', undefined);
  vi.stubGlobal('navigator', { userAgentData: { mobile } });
}

function openData() {
  window.history.replaceState(null, '', '#/analysis?mode=correlation&layout=overlaid');
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <HashRouter>
        <Routes>
          <Route path="/analysis" element={<AnalysisRoute />} />
          <Route path="/history" element={<h1>History</h1>} />
        </Routes>
      </HashRouter>
    </SWRConfig>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('1.0 Data through the hash route', () => {
  it.each([[390, true], [768, true], [768, false], [1440, true]] as const)(
    'uses History at %i px with mobile UA=%s',
    (width, mobile) => {
      arrangeBrowser(width, mobile);
      openData();
      expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();
      expect(api.catalog).not.toHaveBeenCalled();
      expect(api.series).not.toHaveBeenCalled();
      expect(api.listViews).not.toHaveBeenCalled();
    },
  );

  it.each([
    [1024, 'enabled'],
    [1440, 'disabled'],
    [1440, 'unavailable'],
  ] as const)('keeps one authorized source, chart and CSV at %i px with Data settings %s', async (width, settings) => {
    arrangeBrowser(width, false);
    if (settings === 'unavailable') api.settings.mockRejectedValue(new Error('Gateway settings unavailable'));
    else api.settings.mockResolvedValue({ dataModuleEnabled: settings === 'enabled' });
    api.catalog.mockResolvedValue({ channels, generatedAt: '2026-11-20T09:00:00Z' });
    api.series.mockImplementation(async ({ selectors }: AnalysisSeriesRequest) => ({
      range: { label: '7d', from: '2026-11-13T00:00:00Z', to: '2026-11-20T00:00:00Z', timezone: 'UTC' },
      aggregation: { applied: 'hourly' },
      series: selectors.map(({ seriesId }) => {
        const channel = channels.find((item) => item.seriesId === seriesId)!;
        return { seriesId, resolved: channel, label: channel.displayName, unit: channel.unit,
          points: [{ t: '2026-11-19T00:00:00Z', value: 30, count: 1, quality: 'ok' }] };
      }),
    }));
    api.listViews.mockResolvedValue([{ id: 1, isDefault: true, viewJson: { mode: 'correlation' } }]);
    const existingView = JSON.stringify({
      schemaVersion: 1,
      mode: 'correlation', layout: 'overlaid', toggles: { normalize: true },
      selectors: [assigned, pulse, unassigned].map(({ seriesId }) => ({ seriesId })),
    });
    localStorage.setItem('osi.analysis.workspace.v1', existingView);

    await import('../CrossZoneAnalysisPage');
    openData();

    expect(await screen.findByTestId('timeline-plot')).toBeInTheDocument();
    expect(api.series).toHaveBeenCalledWith(expect.objectContaining({
      selectors: [{ seriesId: assigned.seriesId }, { seriesId: pulse.seriesId }],
    }));
    expect(api.settings).toHaveBeenCalled();
    expect(api.listViews).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'analysis.mode.label' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'analysis.layout.label' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'analysis.toggle.normalize' })).toBeNull();
    expect(localStorage.getItem('osi.analysis.workspace.v1')).toBe(existingView);

    fireEvent.click(screen.getByText('analysis.export.label'));
    fireEvent.click(screen.getByRole('button', { name: 'analysis.export.csv' }));
    expect(api.download).toHaveBeenCalledWith(expect.stringMatching(/\.csv$/), expect.stringContaining('pipe_pressure_kpa'), 'text/csv');

    // Expand the authorized, unassigned device and pick its pressure channel.
    fireEvent.click(screen.getByText('Unassigned UC512'));
    fireEvent.click(screen.getByText(unassigned.displayName));
    await waitFor(() => expect(api.series).toHaveBeenLastCalledWith(expect.objectContaining({
      selectors: [{ seriesId: unassigned.seriesId }],
    })));
    expect(screen.getByTestId('timeline-plot')).toBeInTheDocument();

    const requests = api.series.mock.calls.length;
    vi.stubGlobal('innerWidth', 768);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument();
    expect(api.series).toHaveBeenCalledTimes(requests);
  });
});
