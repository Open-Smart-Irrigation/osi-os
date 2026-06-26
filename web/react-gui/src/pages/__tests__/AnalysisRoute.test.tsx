// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDesktopBrowser } from '../../utils/isDesktopBrowser';
import { AnalysisRoute } from '../AnalysisRoute';

vi.mock('../../utils/isDesktopBrowser', () => ({
  isDesktopBrowser: vi.fn(() => true),
}));

vi.mock('../CrossZoneAnalysisPage', () => ({
  CrossZoneAnalysisPage: () => <div>analysis page</div>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AnalysisRoute', () => {
  it('renders analysis on desktop', async () => {
    vi.mocked(isDesktopBrowser).mockReturnValue(true);
    render(
      <MemoryRouter initialEntries={['/analysis']}>
        <Routes>
          <Route path="/analysis" element={<AnalysisRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('analysis page')).toBeInTheDocument();
  });

  it('redirects mobile users to history', () => {
    vi.mocked(isDesktopBrowser).mockReturnValue(false);
    render(
      <MemoryRouter initialEntries={['/analysis']}>
        <Routes>
          <Route path="/analysis" element={<AnalysisRoute />} />
          <Route path="/history" element={<div>history page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('history page')).toBeInTheDocument();
  });
});
