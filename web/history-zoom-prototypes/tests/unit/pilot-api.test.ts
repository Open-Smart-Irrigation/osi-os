import { describe, expect, test, vi } from 'vitest';
import { createPilotApi, PilotAuthError, PilotResponseError } from '../../src/pilot/api';
import type { PilotRangeRequest } from '../../src/pilot/types';

const request: PilotRangeRequest = { from: 1_000, to: 2_000, rangeLabel: '24h', aggregation: 'raw' };
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
const emptyData = { range: {}, aggregation: {}, limits: { maxPointsPerSeries: 2000, truncated: false }, series: [] };

describe('pilot API boundary', () => {
  test('builds fixed encoded card paths and safe request options', async () => {
    localStorage.setItem('auth_token', 'fake-token');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ cardId: 'a/b', ...emptyData }));
    const api = createPilotApi('edge', { fetchImpl, origin: 'https://test.invalid' });
    await expect(api.getCardData({ token: 'fake-token', signal: new AbortController().signal, zoneId: 4, cardId: 'a/b', view: 'line-chart', request })).resolves.toMatchObject({ cardId: 'a/b' });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/history/zones/4/cards/a%2Fb/data?'), expect.objectContaining({
      headers: { Accept: 'application/json', Authorization: 'Bearer fake-token' }, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    }));
  });

  test('rejects invalid zone ids and cross-origin paths before fetch', async () => {
    localStorage.setItem('auth_token', 'fake-token');
    const fetchImpl = vi.fn<typeof fetch>();
    const api = createPilotApi('cloud', { fetchImpl, origin: 'https://test.invalid' });
    await expect(api.getCards({ token: 'fake-token', signal: new AbortController().signal, zoneId: 1.5 })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('does not dispatch when the captured token is absent from storage', async () => {
    localStorage.removeItem('auth_token');
    const fetchImpl = vi.fn<typeof fetch>();
    const api = createPilotApi('edge', { fetchImpl });
    await expect(api.getZones({ token: 'fake-token', signal: new AbortController().signal })).rejects.toBeInstanceOf(PilotAuthError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('maps auth statuses without exposing response body or token', async () => {
    localStorage.setItem('auth_token', 'secret-token');
    const api = createPilotApi('edge', { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ secret: 'raw-body' }, 401)) });
    await expect(api.getZones({ token: 'secret-token', signal: new AbortController().signal })).rejects.toBeInstanceOf(PilotAuthError);
    await expect(api.getZones({ token: 'secret-token', signal: new AbortController().signal })).rejects.toThrow('401');
    try { await api.getZones({ token: 'secret-token', signal: new AbortController().signal }); } catch (error) { expect(String(error)).not.toContain('secret-token'); expect(String(error)).not.toContain('raw-body'); }
  });

  test.each([null, 'replacement-token'])('refuses a response when auth_token changes to %s while its body is read', async (nextToken) => {
    localStorage.setItem('auth_token', 'fake-token');
    let release!: (value: unknown) => void;
    const body = new Promise<unknown>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({ status: 200, ok: true, json: () => body } as Response);
    const api = createPilotApi('edge', { fetchImpl });
    const pending = api.getZones({ token: 'fake-token', signal: new AbortController().signal });
    if (nextToken === null) localStorage.removeItem('auth_token');
    else localStorage.setItem('auth_token', nextToken);
    release({ zones: [] });
    await expect(pending).rejects.toBeInstanceOf(PilotAuthError);
  });

  test('checks token after response.json resolves', async () => {
    localStorage.setItem('auth_token', 'fake-token');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({ status: 200, ok: true, json: () => ({ then(resolve: (value: unknown) => void) { resolve({ zones: [] }); localStorage.removeItem('auth_token'); } }) } as Response);
    const api = createPilotApi('edge', { fetchImpl });
    await expect(api.getZones({ token: 'fake-token', signal: new AbortController().signal })).rejects.toBeInstanceOf(PilotAuthError);
  });

  test('rejects a response for a different card id', async () => {
    localStorage.setItem('auth_token', 'fake-token');
    const api = createPilotApi('edge', { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ cardId: 'other', ...emptyData })) });
    await expect(api.getCardData({ token: 'fake-token', signal: new AbortController().signal, zoneId: 4, cardId: 'expected', view: 'line-chart', request })).rejects.toBeInstanceOf(PilotResponseError);
  });
});
