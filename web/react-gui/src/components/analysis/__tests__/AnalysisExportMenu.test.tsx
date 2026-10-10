// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
const downloadBlob = vi.fn();
const downloadDataUrl = vi.fn();
vi.mock('../../../analysis/download', () => ({
  downloadBlob: (...a: unknown[]) => downloadBlob(...a),
  downloadDataUrl: (...a: unknown[]) => downloadDataUrl(...a),
}));
const exportFileName = vi.fn((username: string | null, ext: string) => `${username ?? 'user'}-export.${ext}`);
vi.mock('../../../analysis/exportName', () => ({
  exportFileName: (...a: [string | null, string]) => exportFileName(...a),
}));
const downloadAllZones = vi.fn();
vi.mock('../../../services/api', () => ({
  historyExportAPI: {
    downloadAllZones: (opts: { from: string; to: string; granularity: string }) => downloadAllZones(opts),
  },
}));
import { AnalysisExportMenu } from '../AnalysisExportMenu';
import type { AnalysisSeries } from '../../../analysis/types';

const series: AnalysisSeries[] = [{
  seriesId: 'a',
  resolved: { hubEui: 'H', zoneId: 1, cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1' },
  label: 'a',
  unit: 'kPa',
  coveragePct: 100,
  points: [{ t: 't0', value: 1, count: 1, quality: 'ok' }],
  truncated: false, cadence: 'hourly', timezone: null,
}];

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('AnalysisExportMenu', () => {
  it('renders chart and account-wide export actions', () => {
    render(
      <AnalysisExportMenu
        series={series}
        catalogById={new Map()}
        chartRef={{ current: null }}
        username="admin"
        exportRange={{ from: '2026-06-01', to: '2026-06-07' }}
        exportGranularity="daily"
      />,
    );

    expect(screen.getByRole('button', { name: 'analysis.export.csv' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'analysis.export.png' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'analysis.export.allZonesCsv' })).toBeInTheDocument();
  });

  it('exports CSV via downloadBlob', () => {
    render(
      <AnalysisExportMenu
        series={series}
        catalogById={new Map()}
        chartRef={{ current: null }}
        username="admin"
        exportRange={{ from: '2026-06-01', to: '2026-06-07' }}
        exportGranularity="daily"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'analysis.export.csv' }));
    expect(exportFileName).toHaveBeenCalledWith('admin', 'csv');
    expect(downloadBlob).toHaveBeenCalledWith(
      'admin-export.csv',
      expect.stringContaining('timestamp,'),
      'text/csv',
    );
  });

  it('keeps the version 1 CSV by default and writes version 2 when quality columns are asked for', () => {
    render(
      <AnalysisExportMenu
        series={series}
        catalogById={new Map()}
        chartRef={{ current: null }}
        username="admin"
        exportRange={{ from: '2026-06-01', to: '2026-06-07' }}
        exportGranularity="daily"
        aggregation="hourly"
        rangeEnd="2026-06-07T00:00:00.000Z"
      />,
    );
    // The switch sits with "Export CSV", the only export it changes.
    const csvGroup = screen.getByRole('group', { name: 'analysis.export.csv' });
    const toggle = within(csvGroup).getByRole('checkbox', { name: 'analysis.export.qualityColumns' });
    expect(within(csvGroup).getByRole('button', { name: 'analysis.export.csv' })).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'analysis.export.csv' }));
    expect(String(downloadBlob.mock.calls[0][1]).startsWith('timestamp,site,')).toBe(true);

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'analysis.export.csv' }));
    const v2 = String(downloadBlob.mock.calls[1][1]).split('\n');
    expect(v2[0]).toBe('# osi-csv-version: 2');
    expect(v2[1].endsWith(',timezone,period_start,period_end,quality,coverage,sample_count')).toBe(true);
  });

  it('exports PNG from the chart ref via downloadDataUrl (not downloadBlob)', () => {
    const chartRef = { current: { getDataURL: () => 'data:image/png;base64,OLD', getExportDataURL: () => 'data:image/png;base64,Z' } };
    render(
      <AnalysisExportMenu
        series={series}
        catalogById={new Map()}
        chartRef={chartRef}
        username="admin"
        exportRange={{ from: '2026-06-01', to: '2026-06-07' }}
        exportGranularity="daily"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'analysis.export.png' }));
    expect(exportFileName).toHaveBeenCalledWith('admin', 'png');
    expect(downloadDataUrl).toHaveBeenCalledWith('admin-export.png', 'data:image/png;base64,Z');
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('disables export when there are no series', () => {
    render(
      <AnalysisExportMenu
        series={[]}
        catalogById={new Map()}
        chartRef={{ current: null }}
        username={null}
        exportRange={null}
        exportGranularity="daily"
      />,
    );
    expect(screen.getByRole('button', { name: 'analysis.export.csv' })).toBeDisabled();
  });

  const renderAllZones = () => render(
    <AnalysisExportMenu
      series={series}
      catalogById={new Map()}
      chartRef={{ current: null }}
      username="admin"
      exportRange={{ from: '2026-06-01', to: '2026-06-07' }}
      exportGranularity="raw"
    />,
  );

  it('shows a busy state while the all-zones export runs and clears it afterwards', async () => {
    let finish: () => void = () => undefined;
    downloadAllZones.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderAllZones();

    fireEvent.click(screen.getByRole('button', { name: 'analysis.export.allZonesCsv' }));
    const busy = await screen.findByRole('button', { name: 'analysis.export.allZonesCsvBusy' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(downloadAllZones).toHaveBeenCalledTimes(1);

    finish();
    expect(await screen.findByRole('button', { name: 'analysis.export.allZonesCsv' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    [413, 'analysis.export.errors.tooLarge'],
    [429, 'analysis.export.errors.busy'],
    [400, 'analysis.export.errors.invalidRange'],
    [500, 'analysis.export.errors.failed'],
    [undefined, 'analysis.export.errors.failed'],
  ])('shows a visible message when the all-zones export answers %s', async (status, message) => {
    downloadAllZones.mockRejectedValue(Object.assign(new Error('export failed'), { status }));
    renderAllZones();

    fireEvent.click(screen.getByRole('button', { name: 'analysis.export.allZonesCsv' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    await waitFor(() => expect(screen.getByRole('button', { name: 'analysis.export.allZonesCsv' })).toBeEnabled());
  });

  it('downloads all-zones CSV with the resolved analysis range and granularity', () => {
    render(
      <AnalysisExportMenu
        series={series}
        catalogById={new Map()}
        chartRef={{ current: null }}
        username="admin"
        exportRange={{ from: '2026-06-01', to: '2026-06-07' }}
        exportGranularity="hourly"
      />,
    );

    downloadAllZones.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'analysis.export.allZonesCsv' }));

    expect(downloadAllZones).toHaveBeenCalledWith({
      from: '2026-06-01',
      to: '2026-06-07',
      granularity: 'hourly',
    });
  });
});
