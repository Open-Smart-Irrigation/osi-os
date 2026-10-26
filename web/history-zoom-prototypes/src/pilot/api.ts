import { normalizeCardData, normalizeCards, normalizeZones } from './normalize';
import { platformConfig } from './platform';
import type { PilotApi, PilotApiDependencies, PilotAuthInput, PilotCard, PilotPlatform, PilotRangeRequest, PilotAcceptedData, PilotZone } from './types';
import { PilotAuthError, PilotHttpError, PilotResponseError } from './types';

function currentToken(): string | null {
  try { return typeof window === 'undefined' ? null : window.localStorage.getItem('auth_token'); } catch { return null; }
}
function validZone(zoneId: number): void { if (!Number.isInteger(zoneId) || zoneId <= 0) throw new PilotResponseError('Invalid zone id'); }
function validCard(cardId: string): void { if (!cardId.trim()) throw new PilotResponseError('Invalid card id'); }
export function createPilotApi(platform: PilotPlatform, dependencies: PilotApiDependencies = {}): PilotApi {
  const config = platformConfig(platform);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const origin = dependencies.origin ?? (typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
  async function getJson(path: string, input: PilotAuthInput): Promise<unknown> {
    if (!input.token || currentToken() !== input.token) throw new PilotAuthError(401, 'Login required');
    const base = new URL(origin);
    const url = new URL(path, base);
    if (url.origin !== base.origin || !(url.pathname === config.historyPrefix || url.pathname.startsWith(`${config.historyPrefix}/`) || url.pathname === config.zonesPath)) throw new PilotResponseError('Unsafe API path');
    const response = await fetchImpl(url.toString(), { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${input.token}` }, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: input.signal });
    if (response.status === 401 || response.status === 403) throw new PilotAuthError(response.status, `Authentication required (${response.status})`);
    if (!response.ok) throw new PilotHttpError(response.status, `History request failed (${response.status})`);
    let body: unknown;
    try { body = await response.json() as unknown; } catch { throw new PilotResponseError('Malformed JSON response'); }
    if (currentToken() !== input.token) throw new PilotAuthError(401, 'Session changed');
    return body;
  }
  return {
    async getZones(input) { return normalizeZones(await getJson(config.zonesPath, input)); },
    async getCards(input) { validZone(input.zoneId); return normalizeCards(await getJson(`${config.historyPrefix}/zones/${input.zoneId}/cards`, input)); },
    async getCardData(input) {
      validZone(input.zoneId); validCard(input.cardId);
      const params = new URLSearchParams({ view: input.view, range: input.request.rangeLabel, from: new Date(input.request.from).toISOString(), to: new Date(input.request.to).toISOString(), aggregation: input.request.aggregation });
      const data = normalizeCardData(await getJson(`${config.historyPrefix}/zones/${input.zoneId}/cards/${encodeURIComponent(input.cardId)}/data?${params}`, input), input.request);
      if (data.cardId !== input.cardId) throw new PilotResponseError('History response card does not match request');
      return data;
    },
  };
}
export { PilotAuthError, PilotHttpError, PilotResponseError };
export type { PilotApiDependencies, PilotApi, PilotAuthInput, PilotCard, PilotAcceptedData, PilotRangeRequest, PilotZone } from './types';
