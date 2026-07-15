// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemStats } from '../../services/api';
import { systemAPI } from '../../services/api';
import { GatewayRestartBanner } from '../GatewayRestartBanner';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    systemAPI: {
      ...actual.systemAPI,
      getStats: vi.fn(),
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (
      key === 'restart.in_progress'
        ? 'Restart in progress'
        : `${key}:${String(options?.count ?? '')}`
    ),
  }),
}));

type RestartPending = {
  restartAt: string;
  reason: string;
} | null;

function makeStats(restartPending: RestartPending): SystemStats {
  return {
    cpu_temp_c: 42,
    mem_total_mb: 1024,
    mem_used_mb: 512,
    mem_free_mb: 512,
    mem_percent: 50,
    load_1: 0.1,
    load_5: 0.2,
    load_15: 0.3,
    cpu_count: 4,
    fan_available: false,
    fan_mode: 'none',
    fan_value: null,
    fan_max: null,
    restartPending,
  } as SystemStats;
}

async function flushRequests() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
  vi.mocked(systemAPI.getStats).mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GatewayRestartBanner', () => {
  it('shows an accessible future countdown and decrements it locally each second', async () => {
    vi.mocked(systemAPI.getStats).mockResolvedValue(makeStats({
      restartAt: '2026-07-15T12:00:05.000Z',
      reason: 'gateway_identity_change',
    }));

    render(<GatewayRestartBanner />);
    await flushRequests();

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('restart.gateway_identity_change:5');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(status).toHaveTextContent('restart.gateway_identity_change:4');
  });

  it('parses a restart timestamp once while the local countdown ticks', async () => {
    const parse = vi.spyOn(Date, 'parse');
    vi.mocked(systemAPI.getStats).mockResolvedValue(makeStats({
      restartAt: '2026-07-15T12:00:05.000Z',
      reason: 'gateway_identity_change',
    }));

    render(<GatewayRestartBanner />);
    await flushRequests();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(parse).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['gateway_identity_change', 'restart.gateway_identity_change:5'],
    ['chirpstack_bootstrap', 'restart.chirpstack_bootstrap:5'],
    ['account_link', 'restart.account_link:5'],
    ['account_unlink', 'restart.account_unlink:5'],
    ['future_reason', 'restart.generic:5'],
  ])('maps %s to its reviewed message', async (reason, expected) => {
    vi.mocked(systemAPI.getStats).mockResolvedValue(makeStats({
      restartAt: '2026-07-15T12:00:05.000Z',
      reason,
    }));

    render(<GatewayRestartBanner />);
    await flushRequests();

    expect(screen.getByRole('status')).toHaveTextContent(expected);
  });

  it('renders nothing when the successful response has no pending restart', async () => {
    vi.mocked(systemAPI.getStats).mockResolvedValue(makeStats(null));

    render(<GatewayRestartBanner />);
    await flushRequests();

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders nothing for an invalid pending timestamp', async () => {
    vi.mocked(systemAPI.getStats).mockResolvedValue(makeStats({
      restartAt: 'not-a-date',
      reason: 'gateway_identity_change',
    }));

    render(<GatewayRestartBanner />);
    await flushRequests();

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps an already-expired pending restart visible as in progress', async () => {
    vi.mocked(systemAPI.getStats).mockResolvedValue(makeStats({
      restartAt: '2026-07-15T11:59:59.000Z',
      reason: 'gateway_identity_change',
    }));

    render(<GatewayRestartBanner />);
    await flushRequests();

    expect(screen.getByRole('status')).toHaveTextContent('Restart in progress');
  });

  it('renders nothing after an initial API error', async () => {
    vi.mocked(systemAPI.getStats).mockRejectedValue(new Error('offline'));

    render(<GatewayRestartBanner />);
    await flushRequests();

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('retains the last successful restart through a transient polling error', async () => {
    vi.mocked(systemAPI.getStats)
      .mockResolvedValueOnce(makeStats({
        restartAt: '2026-07-15T12:01:00.000Z',
        reason: 'gateway_identity_change',
      }))
      .mockRejectedValueOnce(new Error('offline'));

    render(<GatewayRestartBanner />);
    await flushRequests();
    expect(screen.getByRole('status')).toHaveTextContent('restart.gateway_identity_change:60');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });

    expect(systemAPI.getStats).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('restart.gateway_identity_change:30');
  });

  it('clears the banner after a later successful poll reports no pending restart', async () => {
    vi.mocked(systemAPI.getStats)
      .mockResolvedValueOnce(makeStats({
        restartAt: '2026-07-15T12:01:00.000Z',
        reason: 'gateway_identity_change',
      }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(makeStats(null));

    render(<GatewayRestartBanner />);
    await flushRequests();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });

    expect(systemAPI.getStats).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not overlap polls while a request is still pending', async () => {
    let resolveFirst: ((stats: SystemStats) => void) | undefined;
    vi.mocked(systemAPI.getStats).mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve;
    }));

    render(<GatewayRestartBanner />);
    await flushRequests();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(systemAPI.getStats).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst?.(makeStats(null));
      await Promise.resolve();
    });
    vi.mocked(systemAPI.getStats).mockResolvedValue(makeStats(null));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(systemAPI.getStats).toHaveBeenCalledTimes(2);
  });

  it('clears polling and countdown intervals and ignores completion after unmount', async () => {
    let resolveNext: ((stats: SystemStats) => void) | undefined;
    vi.mocked(systemAPI.getStats)
      .mockResolvedValueOnce(makeStats({
        restartAt: '2026-07-15T12:01:00.000Z',
        reason: 'gateway_identity_change',
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveNext = resolve;
      }));

    const view = render(<GatewayRestartBanner />);
    await flushRequests();
    expect(vi.getTimerCount()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(systemAPI.getStats).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      resolveNext?.(makeStats(null));
      await Promise.resolve();
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
