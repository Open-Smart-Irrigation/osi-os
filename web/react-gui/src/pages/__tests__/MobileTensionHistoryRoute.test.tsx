// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

const getAll = vi.fn();
const useMobileTensionCatalog = vi.fn();
const logout = vi.fn();

class TestHistoryAuthError extends Error {
  status: 401 | 403;
  constructor(status: 401 | 403) {
    super(`auth ${status}`);
    this.status = status;
  }
}

vi.mock('@osi/history-uplot', () => ({
  HistoryAuthError: TestHistoryAuthError,
  MobileTensionHistory: ({ zoneLabel }: { zoneLabel: string }) => <div data-testid="mobile-shell">{zoneLabel}</div>,
}));
vi.mock('../../services/api', () => ({ irrigationZonesAPI: { getAll } }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ sessionIdentity: { serverInstance: 'edge', principalId: null, sessionEpoch: 3 }, logout }),
}));
vi.mock('../../services/authSession', () => ({ serializeSessionIdentity: (identity: unknown) => JSON.stringify(identity) }));
vi.mock('../../history/mobileAnalysisHistoryAdapter', () => ({ createMobileAnalysisLoader: () => vi.fn() }));
vi.mock('../../history/useMobileTensionCatalog', () => ({ useMobileTensionCatalog }));
vi.mock('../../history/mobileTensionLabels', () => ({ mobileTensionLabels: () => ({}) }));
vi.mock('../../history/mobileHistoryInternalGate', () => ({
  MOBILE_HISTORY_INTERNAL_ENABLED: true,
  MOBILE_HISTORY_INTERNAL_DIAGNOSTICS_ENABLED: false,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', resolvedLanguage: 'en' } }) }));

let MobileTensionHistoryRoute: (props?: Record<string, never>) => ReactNode;
let parseMobileHistoryZoneId: (value: string | undefined) => number | null;

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderRoute(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/internal/mobile-history/zones/:zoneId" element={<MobileTensionHistoryRoute />} />
        <Route path="/history" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeAll(async () => {
  ({ MobileTensionHistoryRoute, parseMobileHistoryZoneId } = await import('../MobileTensionHistoryRoute'));
});

beforeEach(() => {
  getAll.mockReset();
  useMobileTensionCatalog.mockReset();
  logout.mockReset();
  useMobileTensionCatalog.mockReturnValue({ sources: [], defaultSelectedIds: [], error: null, isLoading: false, refreshForGeneration: vi.fn() });
});

afterEach(() => cleanup());

describe('mobile tension history route', () => {
  it('accepts only positive safe decimal integer zone ids', () => {
    expect(parseMobileHistoryZoneId('1')).toBe(1);
    expect(parseMobileHistoryZoneId('001')).toBe(1);
    expect(parseMobileHistoryZoneId('0')).toBeNull();
    expect(parseMobileHistoryZoneId('-1')).toBeNull();
    expect(parseMobileHistoryZoneId('1e2')).toBeNull();
    expect(parseMobileHistoryZoneId('9007199254740992')).toBeNull();
    expect(parseMobileHistoryZoneId(undefined)).toBeNull();
  });

  it('loads the zone before enabling the catalog and passes the zone to the shell', async () => {
    getAll.mockResolvedValue([{ id: 7, name: 'North block', timezone: 'UTC' }]);
    renderRoute('/internal/mobile-history/zones/7');
    await waitFor(() => expect(screen.getByTestId('mobile-shell')).toHaveTextContent('North block'));
    expect(useMobileTensionCatalog).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, zoneId: '7' }));
  });

  it('does not enable the catalog when the zone timezone is absent or invalid', async () => {
    getAll.mockResolvedValue([{ id: 7, name: 'North block', timezone: 'Not/AZone' }]);
    renderRoute('/internal/mobile-history/zones/7');
    await waitFor(() => expect(screen.getByText('mobileTension.route.timeZoneUnavailable')).toBeInTheDocument());
    expect(useMobileTensionCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('redirects an absent zone only after the successful zone list arrives', async () => {
    getAll.mockResolvedValue([{ id: 8, name: 'Other block', timezone: 'UTC' }]);
    renderRoute('/internal/mobile-history/zones/7');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/history'));
  });

  it('keeps a catalog 403 local and does not log out', async () => {
    getAll.mockResolvedValue([{ id: 7, name: 'North block', timezone: 'UTC' }]);
    useMobileTensionCatalog.mockReturnValue({
      sources: [], defaultSelectedIds: [], error: new TestHistoryAuthError(403), isLoading: false, refreshForGeneration: vi.fn(),
    });
    renderRoute('/internal/mobile-history/zones/7');
    await waitFor(() => expect(screen.getByText('mobileTension.accessDenied')).toBeInTheDocument());
    expect(logout).not.toHaveBeenCalled();
  });
});
