// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { isDesktopBrowser } from '../../utils/isDesktopBrowser';
import { DashboardHeader } from '../DashboardHeader';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        add: 'Add',
        'addMenu.zone': 'Zone',
        'addMenu.device': 'Device',
        data: 'Data',
        account: 'Account',
        'accountMenu.osiServer': 'OSI Server',
        logout: 'Logout',
      };
      if (key === 'welcome') return `Welcome ${String(options?.username ?? '')}`;
      return map[key] ?? key;
    },
  }),
}));

vi.mock('../LanguageSwitcher', () => ({
  LanguageSwitcher: () => <div aria-label="language switcher" />,
}));

vi.mock('../../utils/isDesktopBrowser', () => ({
  isDesktopBrowser: vi.fn(() => true),
}));

function renderHeader(overrides: Partial<ComponentProps<typeof DashboardHeader>> = {}) {
  const props: ComponentProps<typeof DashboardHeader> = {
    username: 'farmer',
    onAddZone: vi.fn(),
    onAddDevice: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };
  render(<BrowserRouter><DashboardHeader {...props} /></BrowserRouter>);
  return props;
}

beforeEach(() => {
  vi.mocked(isDesktopBrowser).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DashboardHeader (osi-os)', () => {
  it('renders the OSI OS title, welcome text, and language switcher', () => {
    renderHeader();
    expect(screen.getByRole('heading', { name: 'OSI OS Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Welcome farmer')).toBeInTheDocument();
    expect(screen.getByLabelText('language switcher')).toBeInTheDocument();
  });

  it('fires add callbacks from the Add menu', () => {
    const { onAddZone, onAddDevice } = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Zone' }));
    expect(onAddZone).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Device' }));
    expect(onAddDevice).toHaveBeenCalledOnce();
  });

  it('shows the desktop Data link to /history', () => {
    renderHeader();
    expect(screen.getByRole('link', { name: 'Data' })).toHaveAttribute('href', '/history');
  });

  it('hides the Data link on mobile/tablet browsers', () => {
    vi.mocked(isDesktopBrowser).mockReturnValue(false);
    renderHeader();
    expect(screen.queryByRole('link', { name: 'Data' })).not.toBeInTheDocument();
  });

  it('puts OSI Server and Logout in the Account menu', () => {
    const { onLogout } = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('menuitem', { name: 'OSI Server' })).toHaveAttribute('href', '/account-link');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Logout' }));
    expect(onLogout).toHaveBeenCalledOnce();
  });
});
