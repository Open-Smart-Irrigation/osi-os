// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountLink } from '../AccountLink';
import { isSyncTokenAuthFailure } from '../../services/api';

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getSyncState: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  forceSync: vi.fn(),
}));

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  accountLinkAPI: {
    getStatus: mocks.getStatus,
    getSyncState: mocks.getSyncState,
    link: mocks.link,
    unlink: mocks.unlink,
    forceSync: mocks.forceSync,
  },
}));

// Keys, not prose: this suite asserts which state the page decided to show, not
// the wording of the (separately guarded) locale files.
const translate = (key: string, options?: Record<string, unknown>) => (
  options && Object.keys(options).length ? `${key}:${JSON.stringify(options)}` : key
);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const LINKED_STATUS = {
  linked: true,
  serverUsername: 'silvan',
  linkedAt: '2026-07-01T00:00:00.000Z',
  serverUrl: 'https://server.opensmartirrigation.org',
};

const HEALTHY_STATE = {
  pendingOutboxCount: 3,
  rejectedOutboxCount: 0,
  rejectedLast24h: 0,
  lastRejection: null,
  lastOutboxDeliverySuccessAt: '2026-09-16T23:29:36.987Z',
  lastError: null,
};

const renderPage = () => render(<MemoryRouter><AccountLink /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStatus.mockResolvedValue(LINKED_STATUS);
  mocks.getSyncState.mockResolvedValue(HEALTHY_STATE);
});

describe('isSyncTokenAuthFailure', () => {
  it('flags 401/403 on a sync-token-bearing source', () => {
    expect(isSyncTokenAuthFailure({ source: 'sync-token-refresh', message: 'x', statusCode: 403 })).toBe(true);
    expect(isSyncTokenAuthFailure({ source: 'outbox', message: 'x', statusCode: 401 })).toBe(true);
    expect(isSyncTokenAuthFailure({ source: 'pending-commands', message: 'x', statusCode: 403 })).toBe(true);
  });

  it('does not flag non-auth failures or unrelated sources', () => {
    expect(isSyncTokenAuthFailure(null)).toBe(false);
    expect(isSyncTokenAuthFailure({ source: 'outbox', message: 'x', statusCode: 500 })).toBe(false);
    expect(isSyncTokenAuthFailure({ source: 'outbox', message: 'x', statusCode: null })).toBe(false);
    expect(isSyncTokenAuthFailure({ source: 'device_data', message: 'x', statusCode: 403 })).toBe(false);
  });
});

describe('AccountLink sync health', () => {
  it('surfaces terminally rejected outbox events with the newest reason', async () => {
    mocks.getSyncState.mockResolvedValue({
      ...HEALTHY_STATE,
      rejectedOutboxCount: 17996,
      rejectedLast24h: 214,
      lastRejection: {
        at: '2026-09-16T23:29:07.634Z',
        op: 'ZONE_ENVIRONMENT_APPENDED',
        reason: 'stale_sync_version',
      },
    });
    renderPage();

    const panel = await screen.findByTestId('sync-rejected-panel');
    expect(panel).toHaveTextContent('rejected.title');
    expect(panel).toHaveTextContent('"total":17996');
    expect(panel).toHaveTextContent('"last24h":214');
    expect(panel).toHaveTextContent('ZONE_ENVIRONMENT_APPENDED');
    expect(panel).toHaveTextContent('stale_sync_version');
  });

  it('hides the rejected panel when nothing has been rejected', async () => {
    renderPage();
    await screen.findByText('status.linked');
    expect(screen.queryByTestId('sync-rejected-panel')).toBeNull();
  });

  it('hides the rejected panel when sync state is not readable (scoped-access 403)', async () => {
    mocks.getSyncState.mockRejectedValue(Object.assign(new Error('Forbidden'), { response: { status: 403 } }));
    renderPage();
    await screen.findByText('status.linked');
    expect(screen.queryByTestId('sync-rejected-panel')).toBeNull();
    expect(screen.queryByTestId('sync-reauth-detected')).toBeNull();
  });

  it('shows the re-authentication banner from an expired token without a manual force sync', async () => {
    mocks.getSyncState.mockResolvedValue({
      ...HEALTHY_STATE,
      lastError: { source: 'sync-token-refresh', message: 'Sync token refresh failed', statusCode: 403 },
    });
    renderPage();

    expect(await screen.findByTestId('sync-reauth-detected')).toHaveTextContent('"statusCode":403');
    expect(screen.getByText('reauth.title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'reauth.button' })).toBeInTheDocument();
    expect(mocks.forceSync).not.toHaveBeenCalled();
  });

  it('does not offer re-authentication for a non-auth sync failure', async () => {
    mocks.getSyncState.mockResolvedValue({
      ...HEALTHY_STATE,
      lastError: { source: 'outbox', message: '2 event(s) rejected by cloud: stale_sync_version x2', statusCode: 200 },
    });
    renderPage();
    await screen.findByText('status.linked');
    expect(screen.queryByTestId('sync-reauth-detected')).toBeNull();
    expect(screen.queryByText('reauth.title')).toBeNull();
  });

  it('re-authenticating with the stored server identity clears the expired-token state', async () => {
    mocks.getSyncState
      .mockResolvedValueOnce({
        ...HEALTHY_STATE,
        lastError: { source: 'sync-token-refresh', message: 'Sync token refresh failed', statusCode: 403 },
      })
      .mockResolvedValue(HEALTHY_STATE);
    mocks.link.mockResolvedValue({
      success: true,
      serverUsername: 'silvan',
      claimedDevices: [],
      skippedDevices: [],
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'reauth.button' }));
    const password = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(password).toBeTruthy();
    fireEvent.change(password, { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'reauth.submit' }));

    await waitFor(() => expect(mocks.link).toHaveBeenCalledWith({
      serverUrl: LINKED_STATUS.serverUrl,
      action: 'login',
      username: LINKED_STATUS.serverUsername,
      password: 'correct horse',
    }));
    await waitFor(() => expect(mocks.getSyncState).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('sync-reauth-detected')).toBeNull());
    expect(screen.queryByText('reauth.title')).toBeNull();
  });
});
