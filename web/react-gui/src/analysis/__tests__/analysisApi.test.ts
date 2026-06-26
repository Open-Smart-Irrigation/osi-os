import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const axiosMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get: axiosMocks.get,
      post: axiosMocks.post,
      put: axiosMocks.put,
      delete: axiosMocks.delete,
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    })),
    isAxiosError: vi.fn(() => false),
  },
}));

describe('analysisAPI', () => {
  beforeEach(() => {
    axiosMocks.post.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-26T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts concrete 90d series ranges to the edge backend', async () => {
    axiosMocks.post.mockResolvedValue({
      data: {
        range: { from: '2026-03-28T12:00:00.000Z', to: '2026-06-26T12:00:00.000Z' },
        aggregation: { requested: 'auto', applied: 'raw' },
        series: [],
        dropped: [],
      },
    });
    const { analysisAPI } = await import('../../services/api');

    await analysisAPI.getSeries({
      selectors: [{ seriesId: 's1' }],
      range: { mode: 'relative', label: '90d', from: null, to: null },
      aggregation: 'auto',
    });

    expect(axiosMocks.post).toHaveBeenCalledWith('/api/analysis/series', {
      selectors: [{ seriesId: 's1' }],
      range: {
        mode: 'absolute',
        label: '90d',
        from: '2026-03-28T12:00:00.000Z',
        to: '2026-06-26T12:00:00.000Z',
      },
      aggregation: 'auto',
    });
  });
});
