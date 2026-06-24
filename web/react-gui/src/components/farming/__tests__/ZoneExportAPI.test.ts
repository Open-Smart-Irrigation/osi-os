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
});
