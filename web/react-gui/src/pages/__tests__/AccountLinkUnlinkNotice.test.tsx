// @vitest-environment jsdom
// Issue #766: after a local unlink the page says the gateway stopped sending
// data and that the cloud account still lists it until it is unlinked there.
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../public/locales/en/accountLink.json';
import { AccountLink } from '../AccountLink';

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

// Resolves keys from the shipped English resource, so the test checks the
// exact sentence a farmer reads.
function lookup(key: string): string {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    en,
  );
  return typeof value === 'string' ? value : key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: lookup }) }));

const NOTICE = 'This gateway stopped sending data. To remove it from your cloud account too, unlink it in the cloud.';

const renderPage = () => render(<MemoryRouter><AccountLink /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStatus.mockResolvedValue({ linked: true, serverUsername: 'farmer', linkedAt: '2026-07-01T00:00:00.000Z', canUnlink: true });
  mocks.getSyncState.mockResolvedValue(null);
  mocks.unlink.mockResolvedValue({});
});

async function unlinkFromPage() {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: en.unlink.button }));
  fireEvent.click(screen.getByRole('button', { name: en.unlink.button }));
}

describe('AccountLink unlink control', () => {
  it.each([
    ['a caller who is not an enabled admin', false],
    ['a status from an older gateway without canUnlink', undefined],
  ])('hides the disconnect button for %s', async (_label, canUnlink) => {
    mocks.getStatus.mockResolvedValue({ linked: true, serverUsername: 'farmer', linkedAt: '2026-07-01T00:00:00.000Z', canUnlink });
    renderPage();
    expect(await screen.findByText(en.unlink.adminOnly)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.unlink.button })).not.toBeInTheDocument();
  });

  it('shows the disconnect button to an admin', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: en.unlink.button })).toBeInTheDocument();
    expect(screen.queryByText(en.unlink.adminOnly)).not.toBeInTheDocument();
  });
});

describe('AccountLink unlink notice', () => {
  it('the English resource carries the exact notice', () => {
    expect(en.unlink.stoppedReporting).toBe(NOTICE);
  });

  it('shows the notice after a successful local unlink', async () => {
    await unlinkFromPage();
    expect(await screen.findByRole('status')).toHaveTextContent(NOTICE);
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    expect(screen.getByText(en.status.notLinked)).toBeInTheDocument();
  });

  it('does not show the notice when the unlink fails', async () => {
    mocks.unlink.mockRejectedValue(new Error('offline'));
    await unlinkFromPage();
    await waitFor(() => expect(screen.getByText(en.errors.generic)).toBeInTheDocument());
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('does not show the notice on a gateway that was already unlinked when the page opened', async () => {
    mocks.getStatus.mockResolvedValue({ linked: false, serverUsername: null, linkedAt: null });
    renderPage();
    expect(await screen.findByText(en.status.notLinked)).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });
});

describe('AccountLink gateway-level disconnect', () => {
  it('shows the disconnect control to an admin whose own account is local when another account linked the gateway', async () => {
    mocks.getStatus.mockResolvedValue({ linked: false, serverUsername: null, linkedAt: null, gatewayLinked: true, canUnlink: true });
    renderPage();
    expect(await screen.findByText(en.status.gatewayLinkedOtherAccount)).toBeInTheDocument();
    expect(screen.queryByText(en.status.notLinked)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: en.unlink.button }));
    fireEvent.click(screen.getByRole('button', { name: en.unlink.button }));
    expect(await screen.findByRole('status')).toHaveTextContent(NOTICE);
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    expect(screen.getByText(en.status.notLinked)).toBeInTheDocument();
  });

  it('gives no disconnect control to a local account that may not unlink a gateway another account linked', async () => {
    mocks.getStatus.mockResolvedValue({ linked: false, serverUsername: null, linkedAt: null, gatewayLinked: true, canUnlink: false });
    renderPage();
    expect(await screen.findByText(en.status.gatewayLinkedOtherAccount)).toBeInTheDocument();
    expect(screen.getByText(en.unlink.adminOnly)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.unlink.button })).not.toBeInTheDocument();
  });

  it('reads the gateway status again after linking, so the disconnect control appears without a reload', async () => {
    mocks.getStatus
      .mockResolvedValueOnce({ linked: false, serverUsername: null, linkedAt: null, gatewayLinked: false, canUnlink: false })
      .mockResolvedValueOnce({ linked: true, serverUsername: 'farmer', linkedAt: '2026-07-01T00:00:00.000Z', gatewayLinked: true, canUnlink: true });
    mocks.link.mockResolvedValue({ success: true, serverUsername: 'farmer', claimedDevices: [], skippedDevices: [] });
    const { container } = renderPage();
    await screen.findByText(en.status.notLinked);
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    fireEvent.click(await screen.findByRole('button', { name: en.warning.proceed }));
    await waitFor(() => expect(mocks.link).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: en.unlink.button })).toBeInTheDocument();
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
  });
});
