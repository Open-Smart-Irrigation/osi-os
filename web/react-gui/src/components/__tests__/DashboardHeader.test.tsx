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
        title: 'Open Smart Irrigation Dashboard',
        'addMenu.zone': 'Zone',
        'addMenu.device': 'Device',
        data: 'Data',
        'settings:entryPoint': 'Settings',
        account: 'Account',
        'accountMenu.osiServer': 'OSI Server',
        'support:navLabel': 'Support & Requests',
        logout: 'Logout',
      };
      if (key === 'welcome') return `Welcome ${String(options?.username ?? '')}`;
      return map[key] ?? key;
    },
  }),
}));

vi.mock('../LanguageSwitcher', () => ({
  LanguageSwitcher: () => <button title="Change language">Lang EN</button>,
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
  it('renders the OSI OS title, welcome text, and Settings entry without a standalone language switcher', () => {
    renderHeader();
    expect(screen.getByRole('heading', { name: 'Open Smart Irrigation Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Welcome farmer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Lang/i })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Change language')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
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

  it('uses the wrapping server-style action layout so header menus are not clipped', () => {
    renderHeader();

    const addMenuWrapper = screen.getByRole('button', { name: 'Add' }).closest('div');
    expect(addMenuWrapper).toHaveClass('w-[calc(50%-4px)]');
    expect(addMenuWrapper).toHaveClass('sm:w-auto');

    const actionGroup = addMenuWrapper?.parentElement;
    expect(actionGroup).toHaveClass('flex-wrap');
    expect(actionGroup).not.toHaveClass('overflow-x-auto');
  });

  it('opens the Add menu from the left edge on compact layouts', () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByRole('menu')).toHaveClass('left-0');
    expect(screen.getByRole('menu')).not.toHaveClass('right-0');
  });

  it('points the desktop Data link to the analysis view', () => {
    renderHeader();
    expect(screen.getByRole('link', { name: 'Data' })).toHaveAttribute('href', '/analysis');
  });

  it('hides the Data link on mobile/tablet browsers', () => {
    vi.mocked(isDesktopBrowser).mockReturnValue(false);
    renderHeader();
    expect(screen.queryByRole('link', { name: 'Data' })).not.toBeInTheDocument();
  });

  it('puts OSI Server, Support Requests, and Logout in the Account menu', () => {
    const { onLogout } = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('menuitem', { name: 'OSI Server' })).toHaveAttribute('href', '/account-link');
    expect(screen.getByRole('menuitem', { name: 'Support & Requests' })).toHaveAttribute('href', '/support-requests');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Logout' }));
    expect(onLogout).toHaveBeenCalledOnce();
  });
});
