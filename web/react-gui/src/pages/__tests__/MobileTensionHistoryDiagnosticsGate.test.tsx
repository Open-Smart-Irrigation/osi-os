// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const getAll = vi.fn();
const useMobileTensionCatalog = vi.fn();
let shellProps: Record<string, unknown> | null = null;

const TestHistoryAuthError = vi.hoisted(() => class extends Error {
  status: 401 | 403;
  constructor(status: 401 | 403) { super(`auth ${status}`); this.status = status; }
});

vi.mock('@osi/history-uplot', () => ({
  HistoryAuthError: TestHistoryAuthError,
  MobileTensionHistory: (props: Record<string, unknown>) => {
    shellProps = props;
    return <div data-testid="mobile-shell">{String(props.zoneLabel)}</div>;
  },
}));
vi.mock('../../services/api', () => ({ irrigationZonesAPI: { getAll } }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ sessionIdentity: { serverInstance: 'edge', principalId: null, sessionEpoch: 3 }, logout: vi.fn() }),
}));
vi.mock('../../services/authSession', () => ({ serializeSessionIdentity: () => '["edge",null,3]' }));
vi.mock('../../history/mobileAnalysisHistoryAdapter', () => ({ createMobileAnalysisLoader: () => vi.fn() }));
vi.mock('../../history/useMobileTensionCatalog', () => ({ useMobileTensionCatalog }));
vi.mock('../../history/mobileTensionLabels', () => ({ mobileTensionLabels: () => ({}) }));
vi.mock('../../history/mobileHistoryInternalGate', () => ({
  MOBILE_HISTORY_INTERNAL_ENABLED: true,
  MOBILE_HISTORY_INTERNAL_DIAGNOSTICS_ENABLED: false,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', resolvedLanguage: 'en' } }) }));

let MobileTensionHistoryRoute: typeof import('../MobileTensionHistoryRoute').MobileTensionHistoryRoute;

beforeAll(async () => {
  ({ MobileTensionHistoryRoute } = await import('../MobileTensionHistoryRoute'));
});

afterEach(() => {
  shellProps = null;
  delete window.__osiMobileHistoryDiagnostics;
  vi.clearAllMocks();
});

describe('edge mobile history diagnostics gate', () => {
  it('does not pass a diagnostics registrar or publish a global when diagnostics is disabled', async () => {
    getAll.mockResolvedValue([{ id: 7, name: 'North block', timezone: 'UTC' }]);
    useMobileTensionCatalog.mockReturnValue({ sources: [], defaultSelectedIds: [], error: null, isLoading: false, refreshForGeneration: vi.fn() });
    render(
      <MemoryRouter initialEntries={['/internal/mobile-history/zones/7']}>
        <Routes><Route path="/internal/mobile-history/zones/:zoneId" element={<MobileTensionHistoryRoute />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('mobile-shell')).toHaveTextContent('North block'));
    expect(shellProps?.registerInternalDiagnostics).toBeUndefined();
    expect(window.__osiMobileHistoryDiagnostics).toBeUndefined();
  });
});
