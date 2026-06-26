// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ username: 'farmer' }) }));
vi.mock('../../analysis/useAnalysisCatalog', () => ({
  useAnalysisCatalog: () => ({ catalog: { channels: [] }, isLoading: false, error: undefined }),
}));
vi.mock('../../analysis/useAnalysisViews', () => ({
  useAnalysisViews: () => ({ views: [], saveView: vi.fn() }),
}));

const seriesFixture = [{
  seriesId: 'a',
  resolved: { hubEui: null, zoneId: 1, cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1' },
  label: 'Chameleon 1: SWT 5cm',
  unit: 'kPa',
  coveragePct: 100,
  points: [],
  truncated: false,
}];

vi.mock('../../analysis/useAnalysisSeries', () => ({
  useAnalysisSeries: () => ({ data: { series: seriesFixture, dropped: [], aggregation: { applied: 'hourly' } }, isLoading: false, error: undefined }),
}));

vi.mock('../../components/analysis/AnalysisChartPanel', () => ({ AnalysisChartPanel: () => <div data-testid="chart" /> }));

import { CrossZoneAnalysisPage } from '../CrossZoneAnalysisPage';

afterEach(() => { cleanup(); localStorage.clear(); });

describe('CrossZoneAnalysisPage label overrides', () => {
  it('renames a series via the legend and persists it to localStorage', () => {
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });
    fireEvent.click(screen.getByRole('button', { name: 'Chameleon 1: SWT 5cm' }));
    const input = screen.getByDisplayValue('Chameleon 1: SWT 5cm');
    fireEvent.change(input, { target: { value: 'Soil A' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Soil A' })).toBeInTheDocument();
    expect(localStorage.getItem('osi.analysis.workspace.v1')).toContain('Soil A');
  });
});
