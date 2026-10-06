import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('zoneExportAPI', () => {
  beforeEach(() => {
    axiosMocks.get.mockReset();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:zone-export'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('downloads zone CSV exports as a blob with range and granularity params', async () => {
    axiosMocks.get.mockResolvedValue({ data: 'timestamp,timezone\n' });
    const { zoneExportAPI } = await import('../../../services/api');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await zoneExportAPI.download(12, { from: '2026-06-01', to: '2026-06-03', granularity: 'daily' });

    expect(axiosMocks.get).toHaveBeenCalledWith('/api/history/zones/12/export.csv', {
      params: { from: '2026-06-01', to: '2026-06-03', granularity: 'daily' },
      responseType: 'blob',
    });
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:zone-export');
    click.mockRestore();
  });

  it('sends canonical channel filters when provided', async () => {
    axiosMocks.get.mockResolvedValue({ data: 'timestamp,site,zone\n' });
    const { zoneExportAPI } = await import('../../../services/api');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await zoneExportAPI.download(12, {
      from: '2026-06-01',
      to: '2026-06-02',
      granularity: 'raw',
      channels: ['swt_1', 'swt_2'],
    });

    expect(axiosMocks.get).toHaveBeenCalledWith('/api/history/zones/12/export.csv', {
      params: {
        from: '2026-06-01',
        to: '2026-06-02',
        granularity: 'raw',
        channels: 'swt_1,swt_2',
      },
      responseType: 'blob',
    });
    click.mockRestore();
  });

  it('downloads account-wide CSV exports with the canonical scope parameter', async () => {
    axiosMocks.get.mockResolvedValue({ data: 'timestamp,site,zone\n' });
    const { historyExportAPI } = await import('../../../services/api');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await historyExportAPI.downloadAllZones({
      from: '2026-06-01',
      to: '2026-06-03',
      granularity: 'daily',
    });

    expect(axiosMocks.get).toHaveBeenCalledWith('/api/history/export.csv', {
      params: {
        scope: 'allZones',
        from: '2026-06-01',
        to: '2026-06-03',
        granularity: 'daily',
      },
      responseType: 'blob',
    });
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
  it('turns a refused all-zones export into an error carrying the status and the server suggestion', async () => {
    const body = new Blob([JSON.stringify({ error: 'export exceeds 200000 rows', suggestion: 'choose a shorter range' })], { type: 'application/json' });
    axiosMocks.get.mockRejectedValue(Object.assign(new Error('Request failed with status code 413'), {
      response: { status: 413, data: body },
    }));
    const { historyExportAPI } = await import('../../../services/api');

    await expect(historyExportAPI.downloadAllZones({ from: '2026-01-01', to: '2026-07-01', granularity: 'raw' }))
      .rejects.toMatchObject({ status: 413, suggestion: 'choose a shorter range' });
  });

  it('keeps the status of a refused export even when its body is not JSON', async () => {
    axiosMocks.get.mockRejectedValue(Object.assign(new Error('Too Many Requests'), {
      response: { status: 429, data: new Blob(['busy'], { type: 'text/plain' }) },
    }));
    const { historyExportAPI } = await import('../../../services/api');

    await expect(historyExportAPI.downloadAllZones({ from: '2026-06-01', to: '2026-06-03', granularity: 'daily' }))
      .rejects.toMatchObject({ status: 429, suggestion: null });
  });
});
