// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { HashRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../AppProviders', () => ({
  AppProviders: ({ children }: { children: ReactNode }) => {
    return <HashRouter>{children}</HashRouter>;
  },
}));
vi.mock('../components/PrivateRoute', () => ({ PrivateRoute: ({ children }: { children: ReactNode }) => <div data-testid="private-route">{children}</div> }));
vi.mock('../components/ScopeStatusBanner', () => ({ ScopeStatusBanner: () => null }));
vi.mock('../components/GatewayRestartBanner', () => ({ GatewayRestartBanner: () => null }));
vi.mock('../components/AdminOnly', () => ({ AdminOnly: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../pages/Login', () => ({ Login: () => <div>LOGIN</div> }));
vi.mock('../pages/Register', () => ({ Register: () => <div>REGISTER</div> }));
vi.mock('../pages/FarmingDashboard', () => ({ FarmingDashboard: () => <div>DASHBOARD_PAGE</div> }));
vi.mock('../pages/JournalPage', () => ({ JournalPage: () => <div>JOURNAL_PAGE</div> }));
vi.mock('../pages/HistoryDashboard', () => ({ HistoryDashboard: () => <div>HISTORY_PAGE</div> }));
vi.mock('../pages/HistoryCardDetailPage', () => ({ HistoryCardDetailPage: () => <div>DETAIL_PAGE</div> }));
vi.mock('../pages/AccountLink', () => ({ AccountLink: () => <div>ACCOUNT_LINK</div> }));
vi.mock('../pages/SettingsPage', () => ({ SettingsPage: () => <div>SETTINGS_PAGE</div> }));
vi.mock('../pages/admin/UsersPage', () => ({ UsersPage: () => <div>USERS</div> }));
vi.mock('../pages/admin/GrantsPage', () => ({ GrantsPage: () => <div>GRANTS</div> }));
vi.mock('../pages/NetworkPage', () => ({ NetworkPage: () => <div>NETWORK</div> }));
vi.mock('../pages/AnalysisRoute', () => ({ AnalysisRoute: () => <div>ANALYSIS</div> }));

const source = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

import App from '../App';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('mobile tension history app route', () => {
  it('keeps the lazy import inside the exact build gate and redirects when disabled', () => {
    expect(source).toContain("import.meta.env.VITE_MOBILE_HISTORY_INTERNAL === 'true'");
    expect(source).toContain("lazy(() => import('./pages/MobileTensionHistoryRoute')");
    expect(source).toContain('<Navigate to="/history" replace />');
    expect(source).toContain('path="/internal/mobile-history/zones/:zoneId"');
  });

  it('redirects the disabled route through the existing private route boundary', async () => {
    window.location.hash = '#/internal/mobile-history/zones/7';
    render(<App />);
    expect(await screen.findByText('HISTORY_PAGE')).toBeInTheDocument();
    expect(screen.getByTestId('private-route')).toBeInTheDocument();
  });
});
