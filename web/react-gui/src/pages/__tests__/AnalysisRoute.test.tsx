// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDesktopBrowser } from '../../utils/isDesktopBrowser';
import { AnalysisRoute } from '../AnalysisRoute';

vi.mock('../../utils/isDesktopBrowser', () => ({
  isDesktopBrowser: vi.fn(() => true),
}));

vi.mock('../CrossZoneAnalysisPage', () => ({
  CrossZoneAnalysisPage: () => <div>analysis page</div>,
}));

let viewportMatches: boolean;
const changes = new EventTarget();

beforeEach(() => {
  viewportMatches = true;
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() { return viewportMatches; },
    addEventListener: changes.addEventListener.bind(changes),
    removeEventListener: changes.removeEventListener.bind(changes),
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('redirects narrow desktop browsers to history', () => {
    viewportMatches = false;
    vi.mocked(isDesktopBrowser).mockReturnValue(true);
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
