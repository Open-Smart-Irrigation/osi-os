// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
import { AnalysisExportMenu } from '../AnalysisExportMenu';
import type { AnalysisSeries } from '../../../analysis/types';

const series: AnalysisSeries[] = [{
  seriesId: 'a',
  resolved: { hubEui: 'H', zoneId: 1, cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1' },
  label: 'a',
  unit: 'kPa',
  coveragePct: 100,
  points: [{ t: 't0', value: 1, count: 1, quality: 'ok' }],
  truncated: false,
}];

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('AnalysisExportMenu', () => {
  it('renders only edge-local export actions', () => {
    render(
      <AnalysisExportMenu
        series={series}
        catalogById={new Map()}
        chartRef={{ current: null }}
        username="admin"
      />,
    );

    expect(screen.getByRole('button', { name: 'analysis.export.csv' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'analysis.export.png' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'analysis.export.allZonesCsv' })).not.toBeInTheDocument();
  });

  it('exports CSV via downloadBlob', () => {
    render(
      <AnalysisExportMenu
        series={series}
        catalogById={new Map()}
        chartRef={{ current: null }}
        username="admin"
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

  it('exports PNG from the chart ref via downloadDataUrl (not downloadBlob)', () => {
    const chartRef = { current: { getDataURL: () => 'data:image/png;base64,OLD', getExportDataURL: () => 'data:image/png;base64,Z' } };
    render(
      <AnalysisExportMenu
        series={series}
        catalogById={new Map()}
        chartRef={chartRef}
        username="admin"
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
      />,
    );
    expect(screen.getByRole('button', { name: 'analysis.export.csv' })).toBeDisabled();
  });
});
