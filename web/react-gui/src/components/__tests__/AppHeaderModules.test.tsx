// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppHeader } from '../AppHeader';

// Module visibility (2026-09-17): the Data view is switchable off in Settings.
// AppHeader carries the primary tab bar (Zones / Data / Journal), so it is the
// second place the Data entry has to disappear from — DashboardHeader is the
// other. Hiding is UI-only: /analysis and /history stay routable.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'tabs.zones': 'Zones',
        'tabs.data': 'Data',
        'tabs.journal': 'Journal',
        admin: 'Admin',
        'adminMenu.users': 'Users',
        'adminMenu.grants': 'Grants',
        'settings:entryPoint': 'Settings',
        account: 'Account',
        'accountMenu.osiServer': 'OSI Server',
        logout: 'Logout',
      };
      if (key === 'welcome') return `Welcome ${String(options?.username ?? '')}`;
      return map[key] ?? key;
    },
  }),
}));

vi.mock('../../utils/isDesktopBrowser', () => ({
  isDesktopBrowser: vi.fn(() => true),
}));

// The Field Journal module is a GATEWAY-level setting, not a per-browser
// preference: switching it off also has to stop the journal-v2 replication
// worker talking to the cloud, which localStorage cannot do. The header reads
// it through this hook.
const gatewayModules = vi.hoisted(() => ({ journalEnabled: true }));

vi.mock('../../hooks/useGatewayModules', () => ({
  useJournalModuleEnabled: () => gatewayModules.journalEnabled,
}));

function renderAppHeader() {
  render(
    <MemoryRouter initialEntries={['/journal']}>
      <AppHeader title="Field Journal" activeTab="journal" username="farmer" onLogout={vi.fn()} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  gatewayModules.journalEnabled = true;
});

afterEach(() => {
  cleanup();
});

describe('AppHeader module visibility', () => {
  it('renders every primary tab when the modules are on by default', () => {
    renderAppHeader();

    expect(screen.getByRole('link', { name: 'Zones' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('link', { name: 'Data' })).toHaveAttribute('href', '/analysis');
    expect(screen.getByRole('link', { name: 'Journal' })).toHaveAttribute('href', '/journal');
  });

  it('hides the Data tab when the data module is off and keeps the others', () => {
    window.localStorage.setItem('osi.modules.data', 'false');
    renderAppHeader();

    expect(screen.queryByRole('link', { name: 'Data' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zones' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Journal' })).toBeInTheDocument();
  });

  it('hides the Journal tab when the journal module is off and keeps the others', () => {
    gatewayModules.journalEnabled = false;
    renderAppHeader();

    expect(screen.queryByRole('link', { name: 'Journal' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zones' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Data' })).toBeInTheDocument();
  });

  it('hides both the Data and Journal tabs when both modules are off', () => {
    gatewayModules.journalEnabled = false;
    window.localStorage.setItem('osi.modules.data', 'false');
    renderAppHeader();

    expect(screen.queryByRole('link', { name: 'Data' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Journal' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zones' })).toBeInTheDocument();
  });

  it('keeps Settings and Account reachable with the data module off', () => {
    window.localStorage.setItem('osi.modules.data', 'false');
    renderAppHeader();

    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
  });
});
