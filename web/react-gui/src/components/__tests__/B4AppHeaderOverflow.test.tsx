// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AppHeader } from '../AppHeader';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => ({ 'tabs.zones': 'Zonen', 'tabs.data': 'Daten', 'tabs.journal': 'Journal', network: 'Netzwerk' })[key] ?? key }) }));
vi.mock('../../hooks/useGatewayModules', () => ({ useGatewayModules: () => ({ data: true, journal: true, network: true }) }));
vi.mock('../../utils/isDesktopBrowser', () => ({ isDesktopBrowser: () => true }));
afterEach(cleanup);

// JSDOM guards the layout contract; the 390px browser fixture measures actual overflow.
it('bounds and wraps all four translated navigation tabs', () => {
  render(<MemoryRouter><AppHeader title="Datenanalyse" username="user" onLogout={vi.fn()} /></MemoryRouter>);
  const strip = screen.getByRole('navigation').firstElementChild;
  expect(strip).toHaveClass('max-w-full', 'flex-wrap');
  expect(screen.getByRole('link', { name: 'Netzwerk' })).toHaveAttribute('href', '/network');
});
